package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const version = "2.0.0"

var (
	homeDir            string
	claudeDir          string
	configDir          string
	configFile         string
	claudeSettingsFile string
	legacySettingsFile string
	shellRcFiles       []string
)

var systemRcFiles = []string{"/etc/profile", "/etc/bashrc", "/etc/zshrc"}

var profileEnvKeys = []string{
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"API_TIMEOUT_MS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
}

func init() {
	var err error
	homeDir, err = os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot determine home directory:", err)
		os.Exit(1)
	}
	claudeDir = filepath.Join(homeDir, ".claude")
	configDir = filepath.Join(homeDir, ".claude-profiles")
	configFile = filepath.Join(configDir, "profiles.json")
	claudeSettingsFile = filepath.Join(claudeDir, "settings.json")
	legacySettingsFile = filepath.Join(claudeDir, "settings.local.json")
	shellRcFiles = []string{
		filepath.Join(homeDir, ".bashrc"),
		filepath.Join(homeDir, ".bash_profile"),
		filepath.Join(homeDir, ".zshrc"),
		filepath.Join(homeDir, ".zprofile"),
		filepath.Join(homeDir, ".profile"),
	}
}

// ---- Types ----

type ProfilesData struct {
	Current  string                       `json:"current"`
	Profiles map[string]map[string]string `json:"profiles"`
}

// ---- File helpers ----

func writeJSONAtomic(path string, v interface{}, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp.%d", path, os.Getpid())
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func backupFile(path string) (string, error) {
	dst := fmt.Sprintf("%s.bak.%d", path, time.Now().UnixMilli())
	src, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer src.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	defer out.Close()
	_, err = io.Copy(out, src)
	return dst, err
}

func checkWritable(path string) bool {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

// ---- Value helpers ----

func maskValue(key, value string) string {
	if (strings.Contains(key, "TOKEN") || strings.Contains(key, "KEY")) && len(value) > 8 {
		return value[:4] + "..." + value[len(value)-4:]
	}
	return value
}

func isManagedEnvKey(key string) bool {
	for _, k := range profileEnvKeys {
		if k == key {
			return true
		}
	}
	return false
}

func isManagedConfigLine(line string) bool {
	t := strings.TrimSpace(line)
	if t == "" || strings.HasPrefix(t, "#") {
		return false
	}
	for _, key := range profileEnvKeys {
		if strings.Contains(t, key) {
			return true
		}
	}
	return false
}

func firstSet(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// ---- Profile management ----

func loadProfiles() ProfilesData {
	os.MkdirAll(configDir, 0o700)
	if _, err := os.Stat(configFile); os.IsNotExist(err) {
		d := ProfilesData{Profiles: map[string]map[string]string{}}
		writeJSONAtomic(configFile, d, 0o600) //nolint
		return d
	}
	data, err := os.ReadFile(configFile)
	if err != nil {
		return ProfilesData{Profiles: map[string]map[string]string{}}
	}
	var d ProfilesData
	if err := json.Unmarshal(data, &d); err != nil {
		return ProfilesData{Profiles: map[string]map[string]string{}}
	}
	if d.Profiles == nil {
		d.Profiles = map[string]map[string]string{}
	}
	return d
}

func saveProfiles(d ProfilesData) {
	if err := writeJSONAtomic(configFile, d, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "Error saving profiles:", err)
		os.Exit(1)
	}
}

// ---- Claude settings management ----

// loadClaudeSettings reads settings.json as a generic map (preserves unknown fields)
// and extracts the env map separately.
func loadClaudeSettings() (map[string]interface{}, map[string]string) {
	settings := map[string]interface{}{}
	data, err := os.ReadFile(claudeSettingsFile)
	if err == nil {
		json.Unmarshal(data, &settings) //nolint
	}
	env := map[string]string{}
	if envVal, ok := settings["env"]; ok {
		if envMap, ok := envVal.(map[string]interface{}); ok {
			for k, v := range envMap {
				if s, ok := v.(string); ok {
					env[k] = s
				}
			}
		}
	}
	return settings, env
}

func saveClaudeSettings(settings map[string]interface{}, env map[string]string) {
	// Warn about shell conflicts
	var conflicts []string
	for _, key := range profileEnvKeys {
		if os.Getenv(key) != "" {
			conflicts = append(conflicts, key)
		}
	}
	if len(conflicts) > 0 {
		fmt.Println("\nWarning: managed environment variables are already set in this shell")
		fmt.Printf("  Conflicting vars: %s\n", strings.Join(conflicts, ", "))
		fmt.Println("  They override Claude config files. Run `claude-proxy doctor` for cleanup guidance.\n")
	}

	// Backup existing file
	if _, err := os.Stat(claudeSettingsFile); err == nil {
		if bp, err := backupFile(claudeSettingsFile); err == nil {
			fmt.Printf("  Backup created: %s\n", bp)
		}
	}

	if len(env) == 0 {
		delete(settings, "env")
	} else {
		settings["env"] = env
	}

	os.MkdirAll(claudeDir, 0o700) //nolint
	if err := writeJSONAtomic(claudeSettingsFile, settings, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "Error saving Claude settings:", err)
		os.Exit(1)
	}
}

// ---- Profile helpers ----

func findCurrentProfile(d ProfilesData, env map[string]string) (string, bool) {
	baseURL := env["ANTHROPIC_BASE_URL"]
	if baseURL == "" {
		return "", false
	}
	for name, p := range d.Profiles {
		if p["ANTHROPIC_BASE_URL"] == baseURL {
			return name, true
		}
	}
	return "", false
}

func syncModelEnv(profile map[string]string) map[string]string {
	p := make(map[string]string, len(profile))
	for k, v := range profile {
		p[k] = v
	}
	isMimo := p["ANTHROPIC_BASE_URL"] == "https://api.xiaomimimo.com/anthropic" || p["ANTHROPIC_MODEL"] == "mimo-v2-pro"
	if isMimo {
		delete(p, "ANTHROPIC_MODEL")
		p["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "mimo-v2-pro"
		p["ANTHROPIC_DEFAULT_SONNET_MODEL"] = "mimo-v2-pro"
		p["ANTHROPIC_DEFAULT_OPUS_MODEL"] = "mimo-v2-pro"
	} else {
		delete(p, "ANTHROPIC_DEFAULT_HAIKU_MODEL")
		delete(p, "ANTHROPIC_DEFAULT_SONNET_MODEL")
		delete(p, "ANTHROPIC_DEFAULT_OPUS_MODEL")
	}
	return p
}

func printEnvEntries(env map[string]string) {
	for _, key := range profileEnvKeys {
		if val, ok := env[key]; ok {
			fmt.Printf("  %s: %s\n", key, maskValue(key, val))
		}
	}
}

// ---- RC file helpers ----

type rcInfo struct {
	path      string
	exists    bool
	writable  bool
	lineCount int
	err       error
}

func scanRcFiles(files []string) []rcInfo {
	result := make([]rcInfo, 0, len(files))
	for _, path := range files {
		info := rcInfo{path: path}
		if _, err := os.Stat(path); os.IsNotExist(err) {
			result = append(result, info)
			continue
		}
		info.exists = true
		info.writable = checkWritable(path)
		data, err := os.ReadFile(path)
		if err != nil {
			info.err = err
		} else {
			for _, line := range strings.Split(string(data), "\n") {
				if isManagedConfigLine(line) {
					info.lineCount++
				}
			}
		}
		result = append(result, info)
	}
	return result
}

func cleanRcFile(path string) (removed int, cleaned string, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, "", err
	}
	lines := strings.Split(string(data), "\n")
	kept := lines[:0]
	for _, line := range lines {
		if isManagedConfigLine(line) {
			removed++
		} else {
			kept = append(kept, line)
		}
	}
	return removed, strings.Join(kept, "\n"), nil
}

// ---- Settings file conflict helpers ----

type settingsInfo struct {
	path        string
	exists      bool
	parseErr    error
	managedKeys []string
	raw         map[string]interface{}
	env         map[string]string
}

func scanSettingsFile(path string) settingsInfo {
	info := settingsInfo{path: path}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return info
	}
	info.exists = true
	data, err := os.ReadFile(path)
	if err != nil {
		info.parseErr = err
		return info
	}
	raw := map[string]interface{}{}
	if err := json.Unmarshal(data, &raw); err != nil {
		info.parseErr = err
		return info
	}
	info.raw = raw
	env := map[string]string{}
	if envVal, ok := raw["env"]; ok {
		if envMap, ok := envVal.(map[string]interface{}); ok {
			for k, v := range envMap {
				if s, ok := v.(string); ok {
					env[k] = s
					if isManagedEnvKey(k) {
						info.managedKeys = append(info.managedKeys, k)
					}
				}
			}
		}
	}
	info.env = env
	return info
}

func saveSettingsRaw(path string, raw map[string]interface{}, env map[string]string) error {
	if len(env) == 0 {
		delete(raw, "env")
	} else {
		raw["env"] = env
	}
	return writeJSONAtomic(path, raw, 0o600)
}

func stripKeys(env map[string]string, keys []string) (map[string]string, int) {
	result := make(map[string]string, len(env))
	for k, v := range env {
		result[k] = v
	}
	removed := 0
	for _, k := range keys {
		if _, ok := result[k]; ok {
			delete(result, k)
			removed++
		}
	}
	return result, removed
}

func printRestartSteps() {
	fmt.Println("Next steps:")
	fmt.Println("  1. Restart your shell session or reconnect to SSH")
	fmt.Println("  2. Run `claude-proxy doctor` to confirm a clean state")
	fmt.Println("  3. Run `claude-proxy use <profile-name>`")
	fmt.Println("  4. Restart Claude Code")
}

// ---- Commands ----

func cmdAdd(args []string) {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	var t, tl, a, al, m, ml, p, pl, k, kl string
	fs.StringVar(&t, "t", "", "auth token (shorthand)")
	fs.StringVar(&tl, "token", "", "Anthropic auth token")
	fs.StringVar(&a, "a", "", "api key (shorthand)")
	fs.StringVar(&al, "api-key", "", "Anthropic API key")
	fs.StringVar(&m, "m", "", "model (shorthand)")
	fs.StringVar(&ml, "model", "", "Model name")
	fs.StringVar(&p, "p", "", "proxy (shorthand)")
	fs.StringVar(&pl, "proxy", "", "HTTP/HTTPS proxy URL")
	fs.StringVar(&k, "k", "", "timeout (shorthand)")
	fs.StringVar(&kl, "timeout", "", "API timeout in milliseconds")
	fs.Parse(args) //nolint

	if fs.NArg() < 2 {
		fmt.Fprintln(os.Stderr, "Usage: claude-proxy add <name> <baseUrl> [options]")
		os.Exit(1)
	}
	name, baseURL := fs.Arg(0), fs.Arg(1)

	profile := map[string]string{"ANTHROPIC_BASE_URL": baseURL}
	if v := firstSet(tl, t); v != "" {
		profile["ANTHROPIC_AUTH_TOKEN"] = v
	}
	if v := firstSet(al, a); v != "" {
		profile["ANTHROPIC_API_KEY"] = v
	}
	if v := firstSet(ml, m); v != "" {
		profile["ANTHROPIC_MODEL"] = v
	}
	if v := firstSet(pl, p); v != "" {
		profile["HTTP_PROXY"] = v
		profile["HTTPS_PROXY"] = v
	}
	if v := firstSet(kl, k); v != "" {
		profile["API_TIMEOUT_MS"] = v
	}

	d := loadProfiles()
	d.Profiles[name] = syncModelEnv(profile)
	if d.Current == "" {
		d.Current = name
	}
	saveProfiles(d)

	fmt.Printf("Added profile '%s'\n", name)
	fmt.Printf("  Base URL: %s\n", baseURL)
}

func cmdRemove(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: claude-proxy remove <name>")
		os.Exit(1)
	}
	name := args[0]
	d := loadProfiles()
	if _, ok := d.Profiles[name]; !ok {
		fmt.Printf("Profile '%s' not found\n", name)
		os.Exit(1)
	}
	delete(d.Profiles, name)
	if d.Current == name {
		d.Current = ""
		for k := range d.Profiles {
			d.Current = k
			break
		}
	}
	saveProfiles(d)
	fmt.Printf("Removed profile '%s'\n", name)
}

func cmdList(args []string) {
	d := loadProfiles()
	if len(d.Profiles) == 0 {
		fmt.Println("No profiles configured.")
		fmt.Println("Use `claude-proxy add <name> <base-url>` to add one.")
		return
	}
	_, env := loadClaudeSettings()
	currentName, found := findCurrentProfile(d, env)
	if !found {
		currentName = d.Current
	}
	names := make([]string, 0, len(d.Profiles))
	for n := range d.Profiles {
		names = append(names, n)
	}
	sort.Strings(names)
	fmt.Println("Available profiles:")
	for _, n := range names {
		marker := " "
		if n == currentName {
			marker = "*"
		}
		fmt.Printf("  %s %-12s %s\n", marker, n, d.Profiles[n]["ANTHROPIC_BASE_URL"])
	}
}

func cmdUse(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: claude-proxy use <name>")
		os.Exit(1)
	}
	name := args[0]
	d := loadProfiles()
	rawProfile, ok := d.Profiles[name]
	if !ok {
		fmt.Printf("Profile '%s' not found\n", name)
		names := make([]string, 0, len(d.Profiles))
		for k := range d.Profiles {
			names = append(names, k)
		}
		sort.Strings(names)
		if len(names) > 0 {
			fmt.Printf("Available profiles: %s\n", strings.Join(names, ", "))
		} else {
			fmt.Println("Available profiles: (none)")
		}
		os.Exit(1)
	}
	profile := syncModelEnv(rawProfile)
	settings, env := loadClaudeSettings()
	for _, key := range profileEnvKeys {
		delete(env, key)
	}
	for k, v := range profile {
		env[k] = v
	}
	d.Profiles[name] = profile
	d.Current = name
	saveProfiles(d)
	saveClaudeSettings(settings, env)

	fmt.Printf("Switched to profile '%s'\n", name)
	fmt.Printf("  Updated: %s\n", claudeSettingsFile)
	fmt.Println()
	fmt.Println("Configuration:")
	printEnvEntries(profile)
	fmt.Println()
	fmt.Println("Restart Claude Code for changes to take effect.")
}

func cmdCurrent(args []string) {
	d := loadProfiles()
	_, env := loadClaudeSettings()
	if env["ANTHROPIC_BASE_URL"] == "" {
		fmt.Println("No current configuration found.")
		return
	}
	if name, ok := findCurrentProfile(d, env); ok {
		fmt.Printf("Current active profile: %s\n", name)
		fmt.Println()
		printEnvEntries(d.Profiles[name])
		return
	}
	fmt.Println("Current configuration does not match any saved profile.")
	fmt.Println()
	printEnvEntries(env)
}

func cmdShow(args []string) {
	_, env := loadClaudeSettings()
	if len(env) == 0 {
		fmt.Println("No environment configuration found.")
		return
	}
	fmt.Println("Current Claude Code configuration (~/.claude/settings.json):")
	fmt.Println()
	printEnvEntries(env)
}

func cmdDoctor(args []string) {
	fmt.Println("=== Claude Proxy Configuration Doctor ===\n")

	// 1. Shell environment
	fmt.Println("1. Checking current shell environment:")
	var procConflicts []string
	for _, key := range profileEnvKeys {
		if os.Getenv(key) != "" {
			procConflicts = append(procConflicts, key)
		}
	}
	if len(procConflicts) == 0 {
		fmt.Println("   Clean")
	} else {
		fmt.Println("   Conflicts found:")
		for _, key := range procConflicts {
			fmt.Printf("      %s=%s\n", key, maskValue(key, os.Getenv(key)))
		}
	}

	// 2. settings.json
	si := scanSettingsFile(claudeSettingsFile)
	fmt.Println("\n2. Checking ~/.claude/settings.json:")
	if !si.exists {
		fmt.Println("   File does not exist")
	} else if si.parseErr != nil {
		fmt.Printf("   Parse error: %v\n", si.parseErr)
	} else if len(si.managedKeys) == 0 {
		fmt.Println("   No managed keys currently set")
	} else {
		fmt.Printf("   Managed keys: %s\n", strings.Join(si.managedKeys, ", "))
	}

	// 3. legacy settings.local.json
	li := scanSettingsFile(legacySettingsFile)
	fmt.Println("\n3. Checking legacy ~/.claude/settings.local.json:")
	if !li.exists {
		fmt.Println("   File does not exist")
	} else if li.parseErr != nil {
		fmt.Printf("   Parse error: %v\n", li.parseErr)
	} else if len(li.managedKeys) == 0 {
		fmt.Println("   No managed keys currently set")
	} else {
		fmt.Printf("   Legacy managed keys: %s\n", strings.Join(li.managedKeys, ", "))
	}

	// 4. Profiles
	d := loadProfiles()
	fmt.Println("\n4. Checking saved profiles:")
	if len(d.Profiles) == 0 {
		fmt.Println("   No saved profiles")
	} else {
		fmt.Printf("   %d saved profile(s):\n", len(d.Profiles))
		names := make([]string, 0, len(d.Profiles))
		for n := range d.Profiles {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			fmt.Printf("      %-12s -> %s\n", n, d.Profiles[n]["ANTHROPIC_BASE_URL"])
		}
		if d.Current != "" {
			fmt.Printf("   Selected profile: %s\n", d.Current)
		}
	}

	// 5. RC files
	allRc := append(append([]string{}, shellRcFiles...), systemRcFiles...)
	rcInfos := scanRcFiles(allRc)
	fmt.Println("\n5. Checking shell rc files for stale configuration:")
	hasConflicts := false
	for _, info := range rcInfos {
		if info.lineCount > 0 || info.err != nil {
			hasConflicts = true
			if info.err != nil {
				fmt.Printf("   %s: read error (%v)\n", info.path, info.err)
			} else {
				suffix := ""
				if !info.writable {
					suffix = " (not writable)"
				}
				fmt.Printf("   %s: %d managed line(s)%s\n", info.path, info.lineCount, suffix)
			}
		}
	}
	if !hasConflicts {
		fmt.Println("   No managed config lines found")
	}

	// Summary
	total := len(procConflicts)
	for _, info := range rcInfos {
		total += info.lineCount
	}
	fmt.Println("\n=== Summary ===")
	if total == 0 {
		fmt.Println("No conflicts detected in the checked locations.")
		fmt.Println("If switching still fails, restart the shell session and then restart Claude Code.")
	} else {
		fmt.Printf("%d conflict item(s) detected.\n", total)
		fmt.Println("Run `claude-proxy fix` for a safe cleanup or `claude-proxy clean` for a full reset.")
	}
}

func cmdFix(args []string) {
	fmt.Println("=== Claude Proxy Configuration Fix ===\n")
	changedFiles, unsetCount := 0, 0

	// Fix double auth in settings.json
	si := scanSettingsFile(claudeSettingsFile)
	if si.exists && si.parseErr == nil {
		_, hasToken := si.env["ANTHROPIC_AUTH_TOKEN"]
		_, hasKey := si.env["ANTHROPIC_API_KEY"]
		if hasToken && hasKey {
			bp, err := backupFile(claudeSettingsFile)
			if err == nil {
				newEnv, _ := stripKeys(si.env, []string{"ANTHROPIC_AUTH_TOKEN"})
				if err := saveSettingsRaw(claudeSettingsFile, si.raw, newEnv); err == nil {
					fmt.Println("Fixed ~/.claude/settings.json: removed ANTHROPIC_AUTH_TOKEN to avoid auth ambiguity")
					fmt.Printf("  Backup: %s\n", bp)
					changedFiles++
				}
			}
		}
	}

	// Fix legacy file
	li := scanSettingsFile(legacySettingsFile)
	if li.exists && li.parseErr == nil && len(li.managedKeys) > 0 {
		bp, err := backupFile(legacySettingsFile)
		if err == nil {
			newEnv, removed := stripKeys(li.env, li.managedKeys)
			if err := saveSettingsRaw(legacySettingsFile, li.raw, newEnv); err == nil {
				fmt.Printf("Fixed legacy ~/.claude/settings.local.json: removed %d key(s)\n", removed)
				fmt.Printf("  Backup: %s\n", bp)
				changedFiles++
			}
		}
	}

	// Fix shell rc files
	for _, info := range scanRcFiles(shellRcFiles) {
		if !info.exists || info.err != nil || info.lineCount == 0 || !info.writable {
			continue
		}
		bp, err := backupFile(info.path)
		if err != nil {
			continue
		}
		removed, content, err := cleanRcFile(info.path)
		if err != nil {
			continue
		}
		os.WriteFile(info.path, []byte(content), 0o644) //nolint
		fmt.Printf("Fixed %s: removed %d managed line(s)\n", info.path, removed)
		fmt.Printf("  Backup: %s\n", bp)
		changedFiles++
	}

	// Unset in current process
	for _, key := range profileEnvKeys {
		if os.Getenv(key) != "" {
			os.Unsetenv(key) //nolint
			unsetCount++
		}
	}
	if unsetCount > 0 {
		fmt.Printf("Unset %d environment variable(s) in the current process\n", unsetCount)
	}

	fmt.Println("\n=== Fix Complete ===")
	if changedFiles == 0 && unsetCount == 0 {
		fmt.Println("No conflicts needed fixing.")
	} else {
		fmt.Printf("Updated %d file(s) and unset %d variable(s).\n", changedFiles, unsetCount)
		printRestartSteps()
	}
}

func cmdClean(args []string) {
	fmt.Println("=== Claude Proxy Complete Clean ===\n")
	fmt.Println("This removes managed Claude proxy configuration from:")
	fmt.Println("  - ~/.claude/settings.json")
	fmt.Println("  - ~/.claude/settings.local.json")
	fmt.Println("  - shell rc files (.bashrc, .zshrc, etc.)")
	fmt.Println("  - current session environment variables")
	fmt.Println("Saved profiles in ~/.claude-profiles/profiles.json are kept.\n")

	changedFiles, unsetCount := 0, 0

	// Clean settings.json
	si := scanSettingsFile(claudeSettingsFile)
	if si.exists && si.parseErr == nil && len(si.managedKeys) > 0 {
		bp, err := backupFile(claudeSettingsFile)
		if err == nil {
			newEnv, removed := stripKeys(si.env, si.managedKeys)
			if err := saveSettingsRaw(claudeSettingsFile, si.raw, newEnv); err == nil {
				fmt.Printf("Cleaned ~/.claude/settings.json: removed %d key(s)\n", removed)
				fmt.Printf("  Backup: %s\n", bp)
				changedFiles++
			}
		}
	}

	// Clean legacy file
	li := scanSettingsFile(legacySettingsFile)
	if li.exists && li.parseErr == nil && len(li.managedKeys) > 0 {
		bp, err := backupFile(legacySettingsFile)
		if err == nil {
			newEnv, removed := stripKeys(li.env, li.managedKeys)
			if err := saveSettingsRaw(legacySettingsFile, li.raw, newEnv); err == nil {
				fmt.Printf("Cleaned legacy ~/.claude/settings.local.json: removed %d key(s)\n", removed)
				fmt.Printf("  Backup: %s\n", bp)
				changedFiles++
			}
		}
	}

	// Clean rc files
	for _, info := range scanRcFiles(shellRcFiles) {
		if !info.exists || info.err != nil || info.lineCount == 0 || !info.writable {
			continue
		}
		bp, err := backupFile(info.path)
		if err != nil {
			continue
		}
		removed, content, err := cleanRcFile(info.path)
		if err != nil {
			continue
		}
		os.WriteFile(info.path, []byte(content), 0o644) //nolint
		fmt.Printf("Cleaned %s: removed %d managed line(s)\n", info.path, removed)
		fmt.Printf("  Backup: %s\n", bp)
		changedFiles++
	}

	// Unset env vars in current process
	for _, key := range profileEnvKeys {
		if os.Getenv(key) != "" {
			os.Unsetenv(key) //nolint
			unsetCount++
		}
	}
	if unsetCount > 0 {
		fmt.Printf("Unset %d environment variable(s) in the current process\n", unsetCount)
	}

	fmt.Println("\n=== Clean Complete ===")
	fmt.Println("Managed Claude proxy configuration has been removed from writable locations.")
	if changedFiles == 0 && unsetCount == 0 {
		fmt.Println("Nothing needed cleaning.")
	}
	printRestartSteps()
}

func printUsage() {
	fmt.Printf(`claude-proxy v%s - Quickly switch between Claude Code proxy/relay configurations

Usage:
  claude-proxy <command> [options]

Commands:
  add <name> <baseUrl>    Add a new proxy profile
  remove <name>           Remove a proxy profile
  list                    List all proxy profiles
  use <name>              Switch to a proxy profile (alias: switch)
  current                 Show current active profile
  show                    Show current Claude Code configuration
  doctor                  Diagnose configuration conflicts
  fix                     Automatically fix detected conflicts
  clean                   Remove all managed proxy configuration

Options for 'add':
  -t, --token <token>     Anthropic auth token (Authorization bearer token)
  -a, --api-key <key>     Anthropic API key (x-api-key)
  -m, --model <model>     Model name
  -p, --proxy <url>       HTTP/HTTPS proxy URL
  -k, --timeout <ms>      API timeout in milliseconds
`, version)
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "add":
		cmdAdd(os.Args[2:])
	case "remove":
		cmdRemove(os.Args[2:])
	case "list":
		cmdList(os.Args[2:])
	case "use", "switch":
		cmdUse(os.Args[2:])
	case "current":
		cmdCurrent(os.Args[2:])
	case "show":
		cmdShow(os.Args[2:])
	case "doctor":
		cmdDoctor(os.Args[2:])
	case "fix":
		cmdFix(os.Args[2:])
	case "clean":
		cmdClean(os.Args[2:])
	case "--version", "-v", "version":
		fmt.Printf("claude-proxy v%s\n", version)
	case "--help", "-h", "help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}
