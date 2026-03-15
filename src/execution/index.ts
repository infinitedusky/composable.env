import * as fs from 'fs';
import * as path from 'path';
import type { ServiceContract } from '../contracts.js';
import { extractApps, generateEcosystem, serializeEcosystem } from './ecosystem.js';

export { extractApps, generateEcosystem, serializeEcosystem } from './ecosystem.js';
export type { AppConfig } from './ecosystem.js';

export class ExecutionManager {
  private executionDir: string;
  private projectRoot: string;

  constructor(configDir: string, envDir: string = 'env') {
    this.projectRoot = configDir;
    this.executionDir = path.join(configDir, envDir, 'execution');
  }

  /**
   * Generate a PM2 ecosystem config from contracts that have dev fields.
   * Returns the generated ecosystem config string.
   */
  generateFromContracts(
    contracts: Map<string, ServiceContract>,
    profile: string
  ): string {
    const apps = extractApps(contracts, this.projectRoot, profile);
    const config = generateEcosystem(apps);
    return serializeEcosystem(config as { apps: Array<Record<string, unknown>> });
  }

  /**
   * Build the ecosystem.config.cjs file for a profile.
   * Returns the path to the written file.
   */
  async buildEcosystem(
    profile: string,
    contracts: Map<string, ServiceContract>
  ): Promise<string> {
    if (!fs.existsSync(this.executionDir)) {
      await fs.promises.mkdir(this.executionDir, { recursive: true });
    }

    const content = this.generateFromContracts(contracts, profile);
    const outputPath = path.join(this.executionDir, `ecosystem.config.cjs`);
    await fs.promises.writeFile(outputPath, content, 'utf8');
    return outputPath;
  }

  /**
   * Get the PM2 namespace for a profile (used for pm2 start --namespace).
   */
  namespace(profile: string): string {
    return `ce-${profile}`;
  }
}
