#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Command } = require('commander');

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), '.claude-profiles');
const CONFIG_FILE = path.join(CONFIG_DIR, 'profiles.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.local.json');

// Ensure config directory exists
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ current: null, profiles: {} }, null, 2), { mode: 0o600 });
  }
}

// Load all profiles
function loadProfiles() {
  ensureConfigDir();
  const data = fs.readFileSync(CONFIG_FILE, 'utf8');
  return JSON.parse(data);
}

// Save all profiles
function saveProfiles(data) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Load Claude settings
function loadClaudeSettings() {
  if (!fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    return { env: {} };
  }
  const data = fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf8');
  return JSON.parse(data);
}

// Save Claude settings atomically
function saveClaudeSettings(settings) {
  // Check if settings.json has conflicting env configuration
  const SETTINGS_JSON = path.join(os.homedir(), '.claude', 'settings.json');
  if (fs.existsSync(SETTINGS_JSON)) {
    try {
      const settingsJson = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'));
      if (settingsJson.env && Object.keys(settingsJson.env).some(key =>
        key.startsWith('ANTHROPIC_') || key === 'ANTHROPIC_API_KEY'
      )) {
        console.log('\n⚠️  Warning: Found ANTHROPIC_* configuration in settings.json');
        console.log('   Claude Code may use settings.json over settings.local.json');
        console.log('   If switching does not take effect, run:');
        console.log('     echo "{}" > ~/.claude/settings.json');
        console.log();
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Check for conflicting environment variables in the current shell
  const conflictingEnv = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL'
  ].filter(key => process.env[key] !== undefined);

  if (conflictingEnv.length > 0) {
    console.log('\n⚠️  Warning: Found ANTHROPIC_* environment variables already set');
    console.log('   Environment variables override ALL configuration files');
    console.log('   Conflicting vars: ' + conflictingEnv.join(', '));
    console.log('   To fix for current session, run:');
    conflictingEnv.forEach(key => {
      console.log(`     unset ${key}`);
    });
    console.log('   And remove them from your shell rc file (~/.zshrc, ~/.bashrc, etc.)');
    console.log();
  }

  // Create backup before modifying
  if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    const timestamp = Date.now();
    const backupFile = `${CLAUDE_SETTINGS_FILE}.bak.${timestamp}`;
    fs.copyFileSync(CLAUDE_SETTINGS_FILE, backupFile);
    console.log(`  Backup created: ${backupFile}`);
  }

  // Ensure parent directory exists
  const claudeDir = path.dirname(CLAUDE_SETTINGS_FILE);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // Atomic write: write to temp file then rename
  const tempFile = `${CLAUDE_SETTINGS_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tempFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tempFile, CLAUDE_SETTINGS_FILE);
}

// Find matching profile by current config
function findCurrentProfile(profiles, currentSettings) {
  if (!currentSettings.env || !currentSettings.env.ANTHROPIC_BASE_URL) {
    return null;
  }
  const currentBaseUrl = currentSettings.env.ANTHROPIC_BASE_URL;
  return Object.entries(profiles.profiles).find(([_, p]) =>
    p.ANTHROPIC_BASE_URL === currentBaseUrl
  );
}

function main() {
  const program = new Command();

  program
    .name('claude-proxy')
    .description('Quickly switch between different Claude Code proxy/relay configurations')
    .version('1.0.0');

  program
    .command('add <name> <baseUrl>')
    .description('Add a new proxy profile')
    .option('-t, --token <token>', 'Anthropic auth token')
    .option('-m, --model <model>', 'Model name')
    .option('-p, --proxy <proxyUrl>', 'HTTP/HTTPS proxy URL')
    .option('-k, --timeout <ms>', 'API timeout in milliseconds')
    .action((name, baseUrl, options) => {
      const config = loadProfiles();

      // Build profile
      const profile = {
        ANTHROPIC_BASE_URL: baseUrl
      };
      if (options.token) profile.ANTHROPIC_AUTH_TOKEN = options.token;
      if (options.model) profile.ANTHROPIC_MODEL = options.model;
      if (options.proxy) {
        profile.HTTP_PROXY = options.proxy;
        profile.HTTPS_PROXY = options.proxy;
      }
      if (options.timeout) profile.API_TIMEOUT_MS = options.timeout;

      config.profiles[name] = profile;
      if (!config.current) config.current = name;

      saveProfiles(config);
      console.log(`✓ Added profile '${name}'`);
      console.log(`  Base URL: ${baseUrl}`);
    });

  program
    .command('remove <name>')
    .description('Remove a proxy profile')
    .action((name) => {
      const config = loadProfiles();
      if (!config.profiles[name]) {
        console.log(`✗ Profile '${name}' not found`);
        process.exit(1);
      }
      delete config.profiles[name];
      if (config.current === name) {
        config.current = Object.keys(config.profiles)[0] || null;
      }
      saveProfiles(config);
      console.log(`✓ Removed profile '${name}'`);
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
        const profile = config.profiles[name];
        const marker = name === currentName ? '*' : ' ';
        console.log(`  ${marker} ${name.padEnd(12)} ${profile.ANTHROPIC_BASE_URL}`);
      });
    });

  program
    .command('use <name>')
    .alias('switch')
    .description('Switch to a proxy profile (updates Claude Code settings)')
    .action((name) => {
      const config = loadProfiles();

      if (!config.profiles[name]) {
        console.log(`✗ Profile '${name}' not found`);
        console.log('Available profiles:', Object.keys(config.profiles).join(', ') || '(none)');
        process.exit(1);
      }

      const settings = loadClaudeSettings();
      const profile = config.profiles[name];

      // Replace env completely - clear old fields to avoid configuration residue
      // This fixes the issue where old API configurations persist and override new settings
      settings.env = {};

      // Assign all fields from the selected profile
      Object.assign(settings.env, profile);
      config.current = name;

      // Save
      saveProfiles(config);
      saveClaudeSettings(settings);

      console.log(`✓ Switched to profile '${name}'`);
      console.log(`  Updated: ${CLAUDE_SETTINGS_FILE}`);
      console.log('');
      console.log('Configuration:');
      Object.entries(profile).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
      });
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
        Object.entries(match[1]).forEach(([key, value]) => {
          console.log(`  ${key}: ${value}`);
        });
      } else {
        console.log('Current configuration does not match any saved profile.');
        console.log('');
        Object.entries(currentSettings.env).forEach(([key, value]) => {
          console.log(`  ${key}: ${value}`);
        });
      }
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

      console.log('Current Claude Code configuration (settings.local.json):');
      console.log('');
      Object.entries(settings.env).forEach(([key, value]) => {
        // Mask token for security
        let displayValue = value;
        if (key === 'ANTHROPIC_AUTH_TOKEN' && value.length > 8) {
          displayValue = value.substring(0, 4) + '...' + value.substring(value.length - 4);
        }
        console.log(`  ${key}: ${displayValue}`);
      });
    });

  program
    .command('doctor')
    .description('Diagnose configuration conflicts')
    .action(() => {
      console.log('=== Claude Proxy Configuration Doctor ===\n');

      // Check 1: Environment variables
      console.log('1. Checking environment variables:');
      const conflictingEnv = [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_MODEL',
        'API_TIMEOUT_MS'
      ].filter(key => process.env[key] !== undefined);

      if (conflictingEnv.length > 0) {
        console.log('   ⚠️  Found ANTHROPIC_* environment variables:');
        conflictingEnv.forEach(key => {
          const val = process.env[key];
          const display = (key.includes('TOKEN') || key.includes('KEY')) && val.length > 8
            ? val.substring(0, 4) + '...' + val.substring(val.length - 4)
            : val;
          console.log(`      ${key}=${display}`);
        });
        console.log('   ⚠️  Environment variables OVERRIDE ALL configuration files!');
        console.log('   Fix: unset these variables and remove them from your shell rc file\n');
      } else {
        console.log('   ✓ No conflicting environment variables found\n');
      }

      // Check 2: settings.json
      console.log('2. Checking ~/.claude/settings.json:');
      const SETTINGS_JSON = path.join(os.homedir(), '.claude', 'settings.json');
      let hasSettingsJsonConflict = false;
      if (fs.existsSync(SETTINGS_JSON)) {
        try {
          const settingsJson = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'));
          if (settingsJson.env) {
            const anthropicKeys = Object.keys(settingsJson.env).filter(key =>
              key.startsWith('ANTHROPIC_') || key === 'ANTHROPIC_API_KEY'
            );
            if (anthropicKeys.length > 0) {
              hasSettingsJsonConflict = true;
              console.log('   ⚠️  Found ANTHROPIC_* configuration in settings.json:');
              anthropicKeys.forEach(key => {
                const val = settingsJson.env[key];
                const display = (key.includes('TOKEN') || key.includes('KEY')) && val.length > 8
                  ? val.substring(0, 4) + '...' + val.substring(val.length - 4)
                  : val;
                console.log(`      ${key}=${display}`);
              });
              console.log('   ⚠️  Claude Code may use this over settings.local.json');
              console.log('   Fix: echo "{}" > ~/.claude/settings.json\n');
            }
          }
          if (!hasSettingsJsonConflict) {
            console.log('   ✓ No conflicting ANTHROPIC_* configuration found\n');
          }
        } catch (e) {
          console.log('   ⚠️  Failed to parse settings.json: ' + e.message + '\n');
        }
      } else {
        console.log('   ✓ settings.json does not exist\n');
      }

      // Check 3: settings.local.json
      console.log('3. Checking ~/.claude/settings.local.json:');
      if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
        try {
          const settingsLocal = loadClaudeSettings();
          if (settingsLocal.env && Object.keys(settingsLocal.env).length > 0) {
            console.log('   ✓ Configuration found:');
            Object.entries(settingsLocal.env).forEach(([key, value]) => {
              const display = (key.includes('TOKEN') || key.includes('KEY')) && value.length > 8
                ? value.substring(0, 4) + '...' + value.substring(value.length - 4)
                : value;
              console.log(`      ${key}=${display}`);
            });
          } else {
            console.log('   ⚠️  settings.local.json exists but has no env configuration\n');
          }
        } catch (e) {
          console.log('   ⚠️  Failed to parse settings.local.json: ' + e.message + '\n');
        }
      } else {
        console.log('   ⚠️  settings.local.json does not exist\n');
      }

      // Check 4: Saved profiles
      console.log('4. Checking saved profiles:');
      const config = loadProfiles();
      const names = Object.keys(config.profiles);
      if (names.length > 0) {
        console.log(`   ✓ ${names.length} saved profile(s):`);
        names.forEach(name => {
          const p = config.profiles[name];
          console.log(`      ${name.padEnd(12)} → ${p.ANTHROPIC_BASE_URL}`);
        });
        if (config.current) {
          console.log(`   Current selected: ${config.current}`);
        }
      } else {
        console.log('   ⚠️  No saved profiles\n');
      }

      // Check 5: Check shell rc files for environment variables
      console.log('\n5. Checking common shell rc files for ANTHROPIC config:');
      const rcFiles = [
        path.join(os.homedir(), '.bashrc'),
        path.join(os.homedir(), '.bash_profile'),
        path.join(os.homedir(), '.zshrc'),
        path.join(os.homedir(), '.zprofile'),
        path.join(os.homedir(), '.profile'),
        '/etc/profile',
        '/etc/bashrc',
        '/etc/zshrc'
      ];

      let foundInRc = false;
      rcFiles.forEach(rcPath => {
        if (fs.existsSync(rcPath)) {
          try {
            const content = fs.readFileSync(rcPath, 'utf8');
            const lines = content.split('\n');
            const hasAnthropic = lines.some(line =>
              !line.startsWith('#') && line.includes('ANTHROPIC_')
            );
            if (hasAnthropic) {
              foundInRc = true;
              console.log(`   ⚠️  Found ANTHROPIC_ references in: ${rcPath}`);
              console.log('   You need to edit this file and remove the export lines');
            }
          } catch (e) {
            // ignore read errors
          }
        }
      });
      if (!foundInRc) {
        console.log('   ✓ No ANTHROPIC_* found in common shell rc files');
      }

      console.log();

      // Summary
      console.log('=== Summary ===');
      if (conflictingEnv.length === 0 && !hasSettingsJsonConflict && !foundInRc) {
        console.log('✓ No conflicts detected in checked locations.');
        console.log('If switch still not working:');
        console.log('  1. Fully restart your SSH session (disconnect and reconnect)');
        console.log('  2. Fully restart Claude Code after reconnecting');
        console.log('  3. Verify your token is correct for the target API');
      } else {
        console.log('⚠️  Conflicts detected above. Please fix them before switching.');
        console.log('   After fixing, disconnect SSH and reconnect, then:');
        console.log('   claude-proxy use <profile-name>');
        console.log('   claude');
      }
    });

  program.parse();
}

main();
