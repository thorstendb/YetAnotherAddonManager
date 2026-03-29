// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AppConfig } from './shared/types';

const CONFIG_FILE = 'yaam.config.json';

function getDocumentsDir(): string {
  return path.join(os.homedir(), 'Documents');
}

function getConfigPath(): string {
  const docs = getDocumentsDir();
  const configDir = path.join(docs, 'YAAM');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, CONFIG_FILE);
}

/**
 * Try to auto-detect the AddOns folder.
 * Checks common locations under the user's Documents folder.
 */
function detectAddonPath(): string {
  const docs = getDocumentsDir();
  // Possible folder structures: live, liveeu, pts
  const candidates = [
    path.join(docs, 'Elder Scrolls Online', 'liveeu', 'AddOns'),
    path.join(docs, 'Elder Scrolls Online', 'live', 'AddOns'),
    path.join(docs, 'Elder Scrolls Online', 'pts', 'AddOns'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw) as AppConfig;
      // Migrate old field name
      if ((config as any).installedEsoVersions && !config.installedCatalogVersions) {
        config.installedCatalogVersions = (config as any).installedEsoVersions;
        delete (config as any).installedEsoVersions;
      }
      // If no path stored, try auto-detection
      if (!config.addonPath) {
        config.addonPath = detectAddonPath();
      }
      return config;
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }

  // Migrate from old ThEsoAddonManager config if it exists
  const docs = getDocumentsDir();
  const legacyConfigPath = path.join(docs, 'ThEsoAddonManager', 'eso-addon-manager.config.json');
  try {
    if (fs.existsSync(legacyConfigPath)) {
      const raw = fs.readFileSync(legacyConfigPath, 'utf-8');
      const config = JSON.parse(raw) as AppConfig;
      // Migrate old field name
      if ((config as any).installedEsoVersions && !config.installedCatalogVersions) {
        config.installedCatalogVersions = (config as any).installedEsoVersions;
        delete (config as any).installedEsoVersions;
      }
      // Save to new location
      saveConfig(config);
      return config;
    }
  } catch (err) {
    console.error('Failed to migrate legacy config:', err);
  }

  // No config file yet — try auto-detection
  return { addonPath: detectAddonPath() };
}

export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
