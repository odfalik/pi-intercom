import { spawn } from "node:child_process";
import type { CrossMachineOrigin } from "./types.ts";

const SESSION_ID_IN_PATH = /_([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i;
export const DISCOVERY_TIMEOUT_MS = 5_000;
export const DELIVERY_TIMEOUT_MS = 15_000;

export type { CrossMachineOrigin } from "./types.ts";

export interface CrossMachineEnvelope {
  version: 1;
  target: string;
  text: string;
  origin: CrossMachineOrigin;
  trust: "ssh-asserted";
}

export interface SavedMachine {
  label: string;
  target: string;
  enabled: boolean;
}

export interface RemoteAgent {
  name: string;
  sessionId?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
}

export type CommandRunner = (command: string, args: string[], stdin?: string, timeoutMs?: number) => Promise<CommandResult>;

export interface CrossMachineDeps {
  run?: CommandRunner;
  herdrBin?: string;
  remoteCommand?: string;
  remoteCommandByMachine?: Record<string, string>;
  discoveryTimeoutMs?: number;
  deliveryTimeoutMs?: number;
}

export interface CrossMachineDelivery {
  machine: SavedMachine;
  agent: RemoteAgent;
  stdout: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const runCommand: CommandRunner = (command, args, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    resolve({ stdout, stderr, code: timedOut ? 124 : (code ?? 1), ...(timedOut ? { timedOut: true } : {}) });
  });
  child.stdin.end(input);
});

function parseJsonOutput(raw: string, operation: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed) && "result" in parsed) return parsed.result;
    return parsed;
  } catch {
    throw new Error(`${operation} returned invalid JSON.`);
  }
}

export function parseSavedMachines(raw: string): SavedMachine[] {
  const value = parseJsonOutput(raw, "herdr machine list");
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.machines) ? value.machines : [];
  return rows.flatMap((row): SavedMachine[] => {
    if (!isRecord(row) || typeof row.label !== "string" || typeof row.target !== "string") return [];
    return [{ label: row.label, target: row.target, enabled: row.enabled !== false }];
  });
}

export function parseRemoteAgents(raw: string): RemoteAgent[] {
  const value = parseJsonOutput(raw, "herdr agent list");
  const rows = isRecord(value) && Array.isArray(value.agents) ? value.agents : [];
  return rows.flatMap((row): RemoteAgent[] => {
    if (!isRecord(row) || row.agent !== "pi" || typeof row.name !== "string") return [];
    const agentSession = isRecord(row.agent_session) ? row.agent_session : undefined;
    const sessionPath = agentSession?.kind === "path" && typeof agentSession.value === "string" ? agentSession.value : undefined;
    const sessionId = sessionPath?.match(SESSION_ID_IN_PATH)?.[1];
    return [{ name: row.name, ...(sessionId ? { sessionId } : {}) }];
  });
}

export function defaultMachineName(host: string): string {
  return host.split(".", 1)[0]!.toLowerCase();
}

export function resolveOrigin(
  sessions: Array<{ id: string; name?: string; runtimeFallbackAlias?: boolean }>,
  fallbackName: string,
  machineName: string,
  excludeSessionId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): CrossMachineOrigin {
  const envSessionId = env.PI_INTERCOM_SESSION_ID?.trim() || env.PI_SESSION_ID?.trim();
  const source = envSessionId
    ? sessions.find((session) => session.id === envSessionId)
    : sessions.find((session) => session.id !== excludeSessionId && !session.runtimeFallbackAlias && session.name?.toLowerCase() === fallbackName.toLowerCase());
  return {
    name: source?.name?.trim() || fallbackName,
    sessionId: source?.id || envSessionId || "unknown",
    machine: machineName,
  };
}

function splitExplicitMachine(target: string, machines: SavedMachine[]): { agentTarget: string; machines: SavedMachine[] } {
  const at = target.lastIndexOf("@");
  if (at <= 0) return { agentTarget: target, machines };
  const agentTarget = target.slice(0, at);
  const label = target.slice(at + 1).toLowerCase();
  const selected = machines.filter((machine) => machine.label.toLowerCase() === label);
  return { agentTarget, machines: selected.length ? selected : machines };
}

function relaySupportError(machine: string): Error {
  return new Error(`Remote pi-intercom on "${machine}" has no compatible relay support and needs upgrading.`);
}

export async function sendCrossMachine(
  target: string,
  text: string,
  origin: CrossMachineOrigin,
  deps: CrossMachineDeps = {},
): Promise<CrossMachineDelivery> {
  const run = deps.run ?? runCommand;
  const herdr = deps.herdrBin ?? process.env.HERDR_BIN_PATH ?? "herdr";
  const discoveryTimeoutMs = deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const listed = await run(herdr, ["machine", "list", "--json"], undefined, discoveryTimeoutMs);
  if (listed.code !== 0) throw new Error(`Could not list Herdr saved machines: ${listed.timedOut ? "timed out" : listed.stderr.trim() || `exit ${listed.code}`}`);
  const available = parseSavedMachines(listed.stdout).filter((machine) => machine.enabled);
  const explicit = splitExplicitMachine(target, available);

  const discovered = await Promise.all(explicit.machines.map(async (machine) => {
    const result = await run(herdr, ["--machine", machine.label, "agent", "list"], undefined, discoveryTimeoutMs);
    if (result.code !== 0) return { machine, agents: [] as RemoteAgent[], unreachable: true };
    try {
      return { machine, agents: parseRemoteAgents(result.stdout), unreachable: false };
    } catch {
      return { machine, agents: [] as RemoteAgent[], unreachable: true };
    }
  }));

  const matches = discovered.flatMap(({ machine, agents }) => agents
    .filter((agent) => agent.name.toLowerCase() === explicit.agentTarget.toLowerCase() || agent.sessionId === explicit.agentTarget)
    .map((agent) => ({ machine, agent })));
  const unreachable = discovered.filter((entry) => entry.unreachable).map((entry) => entry.machine.label);
  const unreachableSuffix = unreachable.length ? ` Unreachable machines: ${unreachable.join(", ")}.` : "";
  if (matches.length === 0) throw new Error(`No saved Herdr machine has a live Pi agent matching "${target}".${unreachableSuffix}`);
  if (matches.length > 1) throw new Error(`Multiple saved Herdr machines have an agent matching "${target}"; use name@machine.`);

  const match = matches[0]!;
  const envelope: CrossMachineEnvelope = { version: 1, target: match.agent.sessionId ?? match.agent.name, text, origin, trust: "ssh-asserted" };
  const remoteCommand = deps.remoteCommandByMachine?.[match.machine.label] ?? deps.remoteCommand ?? "pi-intercom";
  const delivered = await run(
    "ssh",
    [match.machine.target, `${remoteCommand} relay --envelope-stdin --json`],
    `${JSON.stringify(envelope)}\n`,
    deps.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS,
  );
  let response: unknown;
  try {
    response = JSON.parse(delivered.stdout);
  } catch {
    throw relaySupportError(match.machine.label);
  }
  if (!isRecord(response) || typeof response.ok !== "boolean") throw relaySupportError(match.machine.label);
  if (delivered.code !== 0 || response.ok !== true) {
    if (typeof response.error !== "string") throw relaySupportError(match.machine.label);
    throw new Error(`Remote intercom delivery via ${match.machine.label} failed: ${response.error}`);
  }
  return { ...match, stdout: delivered.stdout };
}

export function parseRelayEnvelope(raw: string): CrossMachineEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid cross-machine relay envelope JSON.");
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Unsupported cross-machine relay envelope version; upgrade pi-intercom on both machines.");
  }
  if (value.trust !== "ssh-asserted" || typeof value.target !== "string" || typeof value.text !== "string" || !isRecord(value.origin)
    || typeof value.origin.name !== "string" || typeof value.origin.sessionId !== "string" || typeof value.origin.machine !== "string") {
    throw new Error("Invalid cross-machine relay envelope.");
  }
  return value as unknown as CrossMachineEnvelope;
}

export function relaySenderName(origin: CrossMachineOrigin): string {
  return `${origin.name}@${origin.machine}`;
}

export function relayMessage(envelope: CrossMachineEnvelope): string {
  return `[Unverified cross-machine origin]\n${envelope.text}`;
}
