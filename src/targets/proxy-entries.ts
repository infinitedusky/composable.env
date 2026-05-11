import type { ServiceContract } from '../contracts.js';

/**
 * Shared entry type for reverse-proxy emitters (nginx, caddy, etc.).
 * Each entry describes one routed hostname → upstream container mapping.
 */
export interface ProxyEntry {
  subdomain: string;       // From contract.target.subdomain
  serviceName: string;     // Profiled service name (e.g., "portainer-local")
  port: number;            // Container-side port
}

/**
 * Extract the first container port from a Docker Compose ports array.
 * Handles formats: "9000:9000", "9000:9000/tcp", "127.0.0.1:9000:9000".
 * Returns the container-side port (right side of the colon).
 */
export function extractPort(ports: unknown[]): number | null {
  for (const p of ports) {
    const str = String(p);
    // Remove protocol suffix
    const clean = str.replace(/\/(tcp|udp)$/, '');
    const parts = clean.split(':');
    // Last part is always the container port
    const containerPort = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(containerPort)) return containerPort;
  }
  return null;
}

/**
 * Collect proxy entries from contracts that have a docker-compose target
 * with a `subdomain` field. The same input is used by both nginx and
 * caddy emitters — they only differ in output format.
 */
export function collectProxyEntries(
  contracts: Map<string, ServiceContract>,
  profileSuffix: string,
): ProxyEntry[] {
  const entries: ProxyEntry[] = [];

  for (const [name, contract] of contracts) {
    if (contract.target?.type !== 'docker-compose') continue;
    if (!contract.target.subdomain) continue;

    const config = contract.target.config || {};
    const ports = config.ports as unknown[] | undefined;

    if (!ports || ports.length === 0) {
      console.warn(
        `⚠️  Contract '${name}' has target.subdomain '${contract.target.subdomain}' ` +
        `but no ports defined — skipping in proxy config.`
      );
      continue;
    }

    // Detect unresolved variable refs in the ports field — common when a
    // contract uses "${service.PORT}:${service.PORT}" but the builder didn't
    // resolve values before passing the contract here. Warn loudly so the
    // missing route is visible rather than silently dropped.
    const hasUnresolvedRefs = ports.some(p => /\$\{[^}]+\}/.test(String(p)));
    if (hasUnresolvedRefs) {
      console.warn(
        `⚠️  Contract '${name}' ports contain unresolved variable references: ` +
        `${ports.map(p => `"${p}"`).join(', ')}. Skipping in proxy config.`
      );
      continue;
    }

    const port = extractPort(ports);
    if (!port) {
      console.warn(
        `⚠️  Contract '${name}' has no parseable port in ${JSON.stringify(ports)} — ` +
        `skipping in proxy config.`
      );
      continue;
    }

    const serviceName = `${contract.target.service}${profileSuffix}`;

    entries.push({
      subdomain: contract.target.subdomain,
      serviceName,
      port,
    });
  }

  return entries;
}
