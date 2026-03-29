#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Command } = require('commander');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CONFIG_DIR = path.join(HOME, '.claude-profiles');
const CONFIG_FILE = path.join(CONFIG_DIR, 'profiles.json');
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const LEGACY_SETTINGS_LOCAL_FILE = path.join(CLAUDE_DIR, 'settings.local.json');

const PROFILE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'API_TIMEOUT_MS',
  'HTTP_PROXY',
  'HTTPS_PROXY'
];

const SHELL_RC_FILES = [
  path.join(HOME, '.bashrc'),
  path.join(HOME, '.bash_profile'),
  path.join(HOME, '.zshrc'),
  path.join(HOME, '.zprofile'),
  path.join(HOME, '.profile')
];

const SYSTEM_RC_FILES = ['/etc/profile', '/etc/bashrc', '/etc/zshrc'];

function ensureDir(dirPath, mode) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode });
  }
}

function ensureConfigDir() {
  ensureDir(CONFIG_DIR, 0o700);
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ current: null, profiles: {} }, null, 2), {
      mode: 0o600
    });
  }
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, data, mode = 0o600) {
  ensureDir(path.dirname(filePath), 0o700);
  const tempFile = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tempFile, filePath);
}

function backupFile(filePath) {
  const backupPath = `${filePath}.bak.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function canWriteFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function maskValue(key, value) {
  if (typeof value !== 'string') {
    return value;
  }
  if ((key.includes('TOKEN') || key.includes('KEY')) && value.length > 8) {
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }
  return value;
}

function isManagedEnvKey(key) {
  return PROFILE_ENV_KEYS.includes(key);
}

function isManagedConfigLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return false;
  }
  return PROFILE_ENV_KEYS.some(key => trimmed.includes(key));
}

function loadProfiles() {
  ensureConfigDir();
  return readJson(CONFIG_FILE, { current: null, profiles: {} });
}

function saveProfiles(data) {
  ensureConfigDir();
  writeJsonAtomic(CONFIG_FILE, data, 0o600);
}

function loadClaudeSettings() {
  return readJson(CLAUDE_SETTINGS_FILE, { env: {} }) || { env: {} };
}

function saveClaudeSettings(settings) {
  const normalized = typeof settings === 'object' && settings !== null ? settings : {};
  if (!normalized.env || typeof normalized.env !== 'object') {
    normalized.env = {};
  }

  const shellConflicts = PROFILE_ENV_KEYS.filter(key => process.env[key] !== undefined);
  if (shellConflicts.length > 0) {
    console.log('\nWarning: managed environment variables are already set in this shell');
    console.log(`  Conflicting vars: ${shellConflicts.join(', ')}`);
    console.log('  They override Claude config files. Run `claude-proxy doctor` for cleanup guidance.\n');
  }

  if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    const backupPath = backupFile(CLAUDE_SETTINGS_FILE);
    console.log(`  Backup created: ${backupPath}`);
  }

  writeJsonAtomic(CLAUDE_SETTINGS_FILE, normalized, 0o600);
}

function findCurrentProfile(profiles, currentSettings) {
  if (!currentSettings.env || !currentSettings.env.ANTHROPIC_BASE_URL) {
    return null;
  }
  const currentBaseUrl = currentSettings.env.ANTHROPIC_BASE_URL;
  return Object.entries(profiles.profiles).find(([, profile]) => {
    return profile.ANTHROPIC_BASE_URL === currentBaseUrl;
  }) || null;
}

function collectProcessEnvConflicts() {
  return PROFILE_ENV_KEYS.filter(key => process.env[key] !== undefined).map(key => ({
    key,
    value: process.env[key]
  }));
}

function collectSettingsFileConflicts(filePath) {
  const result = {
    filePath,
    exists: fs.existsSync(filePath),
    parseError: null,
    keys: [],
    data: null
  };

  if (!result.exists) {
    return result;
  }

  try {
    result.data = readJson(filePath, {});
    const env = result.data && typeof result.data.env === 'object' ? result.data.env : {};
    result.keys = Object.keys(env).filter(isManagedEnvKey);
  } catch (error) {
    result.parseError = error;
  }

  return result;
}

function collectRcFileConflicts(rcFiles) {
  return rcFiles.map(filePath => {
    const info = {
      filePath,
      exists: fs.existsSync(filePath),
      writable: false,
      parseError: null,
      lineCount: 0
    };

    if (!info.exists) {
      return info;
    }

    info.writable = canWriteFile(filePath);

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      info.lineCount = content.split('\n').filter(isManagedConfigLine).length;
    } catch (error) {
      info.parseError = error;
    }

    return info;
  });
}

function printEnvEntries(entries) {
  entries.forEach(([key, value]) => {
    console.log(`  ${key}: ${maskValue(key, value)}`);
  });
}

function stripManagedEnv(settings, keysToStrip) {
  const normalized = typeof settings === 'object' && settings !== null ? settings : {};
  const env = normalized.env && typeof normalized.env === 'object' ? { ...normalized.env } : {};
  let removed = 0;

  keysToStrip.forEach(key => {
    if (key in env) {
      delete env[key];
      removed += 1;
    }
  });

  if (Object.keys(env).length === 0) {
    delete normalized.env;
  } else {
    normalized.env = env;
  }

  return { settings: normalized, removed };
}

function cleanRcFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const cleanedLines = lines.filter(line => !isManagedConfigLine(line));
  return {
    removed: lines.length - cleanedLines.length,
    content: cleanedLines.join('\n')
  };
}

function printRestartSteps() {
  console.log('Next steps:');
  console.log('  1. Restart your shell session or reconnect to SSH');
  console.log('  2. Run `claude-proxy doctor` to confirm a clean state');
  console.log('  3. Run `claude-proxy use <profile-name>`');
  console.log('  4. Restart Claude Code');
}

function main() {
  const program = new Command();

  program
    .name('claude-proxy')
    .description('Quickly switch between different Claude Code proxy/relay configurations')
    .version('1.1.0');

  program
    .command('add <name> <baseUrl>')
    .description('Add a new proxy profile')
    .option('-t, --token <token>', 'Anthropic auth token (Authorization bearer token)')
    .option('-a, --api-key <apiKey>', 'Anthropic API key (x-api-key)')
    .option('-m, --model <model>', 'Model name')
    .option('-p, --proxy <proxyUrl>', 'HTTP/HTTPS proxy URL')
    .option('-k, --timeout <ms>', 'API timeout in milliseconds')
    .action((name, baseUrl, options) => {
      const config = loadProfiles();
      const profile = {
        ANTHROPIC_BASE_URL: baseUrl
      };

      if (options.token) profile.ANTHROPIC_AUTH_TOKEN = options.token;
      if (options.apiKey) profile.ANTHROPIC_API_KEY = options.apiKey;
      if (options.model) profile.ANTHROPIC_MODEL = options.model;
      if (options.proxy) {
        profile.HTTP_PROXY = options.proxy;
        profile.HTTPS_PROXY = options.proxy;
      }
      if (options.timeout) profile.API_TIMEOUT_MS = options.timeout;

      config.profiles[name] = profile;
      if (!config.current) {
        config.current = name;
      }

      saveProfiles(config);
      console.log(`Added profile '${name}'`);
      console.log(`  Base URL: ${baseUrl}`);
    });

  program
    .command('remove <name>')
    .description('Remove a proxy profile')
    .action(name => {
      const config = loadProfiles();
      if (!config.profiles[name]) {
        console.log(`Profile '${name}' not found`);
        process.exit(1);
      }

      delete config.profiles[name];
      if (config.current === name) {
        config.current = Object.keys(config.profiles)[0] || null;
      }

      saveProfiles(config);
      console.log(`Removed profile '${name}'`);
    });

  program
    .command('list')
    .description('List all proxy profiles')
    .action(() => {
      const config = loadProfiles();
      const names = Object.keys(config.profiles);

      if (names.length === 0) {
        console.log('No profiles configured.');
        console.log('Use `claude-proxy add <name> <base-url>` to add one.');
        return;
      }

      const currentSettings = loadClaudeSettings();
      const currentMatch = findCurrentProfile(config, currentSettings);
      const currentName = currentMatch ? currentMatch[0] : config.current;

      console.log('Available profiles:');
      names.forEach(name => {
        const marker = name === currentName ? '*' : ' ';
        console.log(`  ${marker} ${name.padEnd(12)} ${config.profiles[name].ANTHROPIC_BASE_URL}`);
      });
    });

  program
    .command('use <name>')
    .alias('switch')
    .description('Switch to a proxy profile (updates Claude Code settings)')
    .action(name => {
      const config = loadProfiles();
      const profile = config.profiles[name];

      if (!profile) {
        console.log(`Profile '${name}' not found`);
        console.log(`Available profiles: ${Object.keys(config.profiles).join(', ') || '(none)'}`);
        process.exit(1);
      }

      const settings = loadClaudeSettings();
      const preservedEnv = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
      PROFILE_ENV_KEYS.forEach(key => delete preservedEnv[key]);
      settings.env = { ...preservedEnv, ...profile };

      config.current = name;
      saveProfiles(config);
      saveClaudeSettings(settings);

      console.log(`Switched to profile '${name}'`);
      console.log(`  Updated: ${CLAUDE_SETTINGS_FILE}`);
      console.log('');
      console.log('Configuration:');
      printEnvEntries(Object.entries(profile));
      console.log('');
      console.log('Restart Claude Code for changes to take effect.');
    });

  program
    .command('current')
    .description('Show current active profile')
    .action(() => {
      const config = loadProfiles();
      const currentSettings = loadClaudeSettings();

      if (!currentSettings.env || !currentSettings.env.ANTHROPIC_BASE_URL) {
        console.log('No current configuration found.');
        return;
      }

      const match = findCurrentProfile(config, currentSettings);
      if (match) {
        console.log(`Current active profile: ${match[0]}`);
        console.log('');
        printEnvEntries(Object.entries(match[1]));
        return;
      }

      console.log('Current configuration does not match any saved profile.');
      console.log('');
      printEnvEntries(Object.entries(currentSettings.env));
    });

  program
    .command('show')
    .description('Show current Claude Code configuration')
    .action(() => {
      const settings = loadClaudeSettings();

      if (!settings.env || Object.keys(settings.env).length === 0) {
        console.log('No environment configuration found.');
        return;
      }

      console.log('Current Claude Code configuration (~/.claude/settings.json):');
      console.log('');
      printEnvEntries(Object.entries(settings.env));
    });

  program
    .command('doctor')
    .description('Diagnose configuration conflicts')
    .action(() => {
      console.log('=== Claude Proxy Configuration Doctor ===\n');

      const processConflicts = collectProcessEnvConflicts();
      console.log('1. Checking current shell environment:');
      if (processConflicts.length === 0) {
        console.log('   Clean');
      } else {
        console.log('   Conflicts found:');
        processConflicts.forEach(({ key, value }) => {
          console.log(`      ${key}=${maskValue(key, value)}`);
        });
      }

      const settingsJsonState = collectSettingsFileConflicts(CLAUDE_SETTINGS_FILE);
      console.log('\n2. Checking ~/.claude/settings.json:');
      if (!settingsJsonState.exists) {
        console.log('   File does not exist');
      } else if (settingsJsonState.parseError) {
        console.log(`   Parse error: ${settingsJsonState.parseError.message}`);
      } else if (settingsJsonState.keys.length === 0) {
        console.log('   No managed keys currently set');
      } else {
        console.log(`   Managed keys: ${settingsJsonState.keys.join(', ')}`);
      }

      const legacyLocalState = collectSettingsFileConflicts(LEGACY_SETTINGS_LOCAL_FILE);
      console.log('\n3. Checking legacy ~/.claude/settings.local.json:');
      if (!legacyLocalState.exists) {
        console.log('   File does not exist');
      } else if (legacyLocalState.parseError) {
        console.log(`   Parse error: ${legacyLocalState.parseError.message}`);
      } else if (legacyLocalState.keys.length === 0) {
        console.log('   No managed keys currently set');
      } else {
        console.log(`   Legacy managed keys: ${legacyLocalState.keys.join(', ')}`);
      }

      const profiles = loadProfiles();
      const profileNames = Object.keys(profiles.profiles);
      console.log('\n4. Checking saved profiles:');
      if (profileNames.length === 0) {
        console.log('   No saved profiles');
      } else {
        console.log(`   ${profileNames.length} saved profile(s):`);
        profileNames.forEach(name => {
          console.log(`      ${name.padEnd(12)} -> ${profiles.profiles[name].ANTHROPIC_BASE_URL}`);
        });
        if (profiles.current) {
          console.log(`   Selected profile: ${profiles.current}`);
        }
      }

      const rcScan = collectRcFileConflicts([...SHELL_RC_FILES, ...SYSTEM_RC_FILES]);
      console.log('\n5. Checking shell rc files for stale configuration:');
      const rcConflicts = rcScan.filter(info => info.lineCount > 0 || info.parseError);
      if (rcConflicts.length === 0) {
        console.log('   No managed config lines found');
      } else {
        rcConflicts.forEach(info => {
          if (info.parseError) {
            console.log(`   ${info.filePath}: read error (${info.parseError.message})`);
          } else {
            const suffix = info.writable ? '' : ' (not writable)';
            console.log(`   ${info.filePath}: ${info.lineCount} managed line(s)${suffix}`);
          }
        });
      }

      const totalConflicts =
        processConflicts.length +
        rcScan.reduce((sum, info) => sum + info.lineCount, 0);

      console.log('\n=== Summary ===');
      if (totalConflicts === 0) {
        console.log('No conflicts detected in the checked locations.');
        console.log('If switching still fails, restart the shell session and then restart Claude Code.');
      } else {
        console.log(`${totalConflicts} conflict item(s) detected.`);
        console.log('Run `claude-proxy fix` for a safe cleanup or `claude-proxy clean` for a full reset.');
      }
    });

  program
    .command('fix')
    .description('Automatically fix detected configuration conflicts')
    .action(() => {
      console.log('=== Claude Proxy Configuration Fix ===\n');

      let changedFiles = 0;
      let unsetCount = 0;

      const settingsJsonState = collectSettingsFileConflicts(CLAUDE_SETTINGS_FILE);
      if (settingsJsonState.exists && !settingsJsonState.parseError && settingsJsonState.data) {
        const hasDoubleAuth =
          settingsJsonState.data.env &&
          settingsJsonState.data.env.ANTHROPIC_AUTH_TOKEN &&
          settingsJsonState.data.env.ANTHROPIC_API_KEY;

        if (hasDoubleAuth) {
          const backupPath = backupFile(CLAUDE_SETTINGS_FILE);
          const result = stripManagedEnv(settingsJsonState.data, ['ANTHROPIC_AUTH_TOKEN']);
          writeJsonAtomic(CLAUDE_SETTINGS_FILE, result.settings, 0o600);
          console.log('Fixed ~/.claude/settings.json: removed ANTHROPIC_AUTH_TOKEN to avoid auth ambiguity');
          console.log(`  Backup: ${backupPath}`);
          changedFiles += 1;
        }
      }

      const legacyLocalState = collectSettingsFileConflicts(LEGACY_SETTINGS_LOCAL_FILE);
      if (legacyLocalState.exists && !legacyLocalState.parseError && legacyLocalState.keys.length > 0) {
        const backupPath = backupFile(LEGACY_SETTINGS_LOCAL_FILE);
        const result = stripManagedEnv(legacyLocalState.data, legacyLocalState.keys);
        writeJsonAtomic(LEGACY_SETTINGS_LOCAL_FILE, result.settings, 0o600);
        console.log(`Fixed legacy ~/.claude/settings.local.json: removed ${result.removed} key(s)`);
        console.log(`  Backup: ${backupPath}`);
        changedFiles += 1;
      }

      collectRcFileConflicts(SHELL_RC_FILES).forEach(info => {
        if (!info.exists || info.parseError || info.lineCount === 0 || !info.writable) {
          return;
        }
        const backupPath = backupFile(info.filePath);
        const result = cleanRcFile(info.filePath);
        fs.writeFileSync(info.filePath, result.content, { mode: 0o644 });
        console.log(`Fixed ${info.filePath}: removed ${result.removed} managed line(s)`);
        console.log(`  Backup: ${backupPath}`);
        changedFiles += 1;
      });

      PROFILE_ENV_KEYS.forEach(key => {
        if (process.env[key] !== undefined) {
          delete process.env[key];
          unsetCount += 1;
        }
      });
      if (unsetCount > 0) {
        console.log(`Unset ${unsetCount} environment variable(s) in the current process`);
      }

      console.log('\n=== Fix Complete ===');
      if (changedFiles === 0 && unsetCount === 0) {
        console.log('No conflicts needed fixing.');
      } else {
        console.log(`Updated ${changedFiles} file(s) and unset ${unsetCount} variable(s).`);
        printRestartSteps();
      }
    });

  program
    .command('clean')
    .description('Completely clean all managed Claude proxy configuration and start fresh')
    .action(() => {
      console.log('=== Claude Proxy Complete Clean ===\n');
      console.log('This removes managed Claude proxy configuration from:');
      console.log('  - ~/.claude/settings.json');
      console.log('  - ~/.claude/settings.local.json');
      console.log('  - shell rc files (.bashrc, .zshrc, etc.)');
      console.log('  - current session environment variables');
      console.log('Saved profiles in ~/.claude-profiles/profiles.json are kept.\n');

      let changedFiles = 0;
      let unsetCount = 0;

      const settingsJsonState = collectSettingsFileConflicts(CLAUDE_SETTINGS_FILE);
      if (settingsJsonState.exists && !settingsJsonState.parseError && settingsJsonState.keys.length > 0) {
        const backupPath = backupFile(CLAUDE_SETTINGS_FILE);
        const result = stripManagedEnv(settingsJsonState.data, settingsJsonState.keys);
        writeJsonAtomic(CLAUDE_SETTINGS_FILE, result.settings, 0o600);
        console.log(`Cleaned ~/.claude/settings.json: removed ${result.removed} key(s)`);
        console.log(`  Backup: ${backupPath}`);
        changedFiles += 1;
      }

      const legacyLocalState = collectSettingsFileConflicts(LEGACY_SETTINGS_LOCAL_FILE);
      if (legacyLocalState.exists && !legacyLocalState.parseError && legacyLocalState.keys.length > 0) {
        const backupPath = backupFile(LEGACY_SETTINGS_LOCAL_FILE);
        const result = stripManagedEnv(legacyLocalState.data, legacyLocalState.keys);
        writeJsonAtomic(LEGACY_SETTINGS_LOCAL_FILE, result.settings, 0o600);
        console.log(`Cleaned legacy ~/.claude/settings.local.json: removed ${result.removed} key(s)`);
        console.log(`  Backup: ${backupPath}`);
        changedFiles += 1;
      }

      collectRcFileConflicts(SHELL_RC_FILES).forEach(info => {
        if (!info.exists || info.parseError || info.lineCount === 0 || !info.writable) {
          return;
        }
        const backupPath = backupFile(info.filePath);
        const result = cleanRcFile(info.filePath);
        fs.writeFileSync(info.filePath, result.content, { mode: 0o644 });
        console.log(`Cleaned ${info.filePath}: removed ${result.removed} managed line(s)`);
        console.log(`  Backup: ${backupPath}`);
        changedFiles += 1;
      });

      PROFILE_ENV_KEYS.forEach(key => {
        if (process.env[key] !== undefined) {
          delete process.env[key];
          unsetCount += 1;
        }
      });
      if (unsetCount > 0) {
        console.log(`Unset ${unsetCount} environment variable(s) in the current process`);
      }

      console.log('\n=== Clean Complete ===');
      console.log('Managed Claude proxy configuration has been removed from writable locations.');
      if (changedFiles === 0 && unsetCount === 0) {
        console.log('Nothing needed cleaning.');
      }
      printRestartSteps();
    });

  program.parse();
}

main();
