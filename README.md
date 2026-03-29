# Claude Proxy Switch

快速切换 Claude Code 不同中转/代理配置的命令行工具。

国内使用 Claude Code 客户端时，经常需要在不同的中转服务之间切换（火山引擎 Ark、自建中转等），这个工具可以让你一键切换。

## 功能特性

- 保存多个配置文件（profiles）
- 一键切换，自动修改 Claude Code 配置
- 自动备份，防止配置丢失
- 原子写入，不会损坏原有配置
- 保留其他 Claude 配置，只替换本工具管理的环境变量
- 内置 `doctor` / `fix` / `clean`，可清理旧电脑上的残留配置

## 安装

```bash
# 克隆项目
git clone https://github.com/你的用户名/claude-proxy-switch.git
cd claude-proxy-switch
npm install
npm link
```

或者直接使用：

```bash
cd /path/to/claude-proxy-switch
npm install
./bin/claude-proxy-switch.js --help
```

## 使用方法

### 添加配置

```bash
# 添加火山引擎 Ark 配置
claude-proxy add volc https://ark.cn-beijing.volces.com/api/coding \
  --token your-token-here \
  --model ark-code-latest

# 添加使用 x-api-key 鉴权的中转
claude-proxy add cc-club https://claude-code.club/api \
  --api-key your-api-key-here

# 添加直连配置
claude-proxy add direct https://api.anthropic.com \
  --api-key sk-ant-xxx \
  --model claude-3-5-sonnet-20241022

# 添加带 HTTP 代理的配置
claude-proxy add direct-proxy https://api.anthropic.com \
  --token sk-xxx \
  --proxy http://127.0.0.1:7890
```

### 列出所有配置

```bash
claude-proxy list
```

输出示例：

```
Available profiles:
  * volc        https://ark.cn-beijing.volces.com/api/coding
    direct      https://api.anthropic.com
```

### 切换配置

```bash
claude-proxy use direct
# 或者
claude-proxy switch direct
```

切换后需要**重启 Claude Code**才能生效。

### 查看当前配置

```bash
# 查看当前使用哪个 profile
claude-proxy current

# 查看完整的当前 Claude Code 配置（token 会被脱敏）
claude-proxy show
```

### 删除配置

```bash
claude-proxy remove old-profile
```

## 配置文件位置

- 你的 profiles 保存在：`~/.claude-profiles/profiles.json`
- Claude Code 全局配置文件：`~/.claude/settings.json`
- 旧版本错误写入过的文件：`~/.claude/settings.local.json`
- 修改前会自动备份到对应文件的 `.bak.<timestamp>`

## 工作原理

Claude Code 的全局用户配置位于 `~/.claude/settings.json`。这个工具把代理相关环境变量写到这个全局配置的 `env` 字段里。

这个工具：
1. 把你的多个配置保存在 `~/.claude-profiles/profiles.json`
2. 当你切换时，把选中 profile 写入 `~/.claude/settings.json`，并只清理/重写本工具管理的键：`ANTHROPIC_*`、`API_TIMEOUT_MS`、`HTTP_PROXY`、`HTTPS_PROXY`
3. 原子写入保证不会损坏配置
4. 修改前自动备份

## 注意事项

- 配置文件包含你的 API token，工具会自动设置 0600 权限保护
- 切换后必须重启 Claude Code 才能生效
- 工具会保留非代理相关的其他 Claude 配置
- `doctor` 会扫描当前 shell、`~/.claude/settings.json`、历史遗留的 `~/.claude/settings.local.json` 和常见 shell rc 文件
- `fix` 会安全移除冲突项；`clean` 会彻底清空本工具管理的所有代理相关配置，但保留已保存的 profiles
- 对新版 Claude Code，很多中转更适合配置成 `ANTHROPIC_API_KEY`；如果遇到 `Not logged in · Please run /login`，优先尝试 `--api-key`

## License

MIT
