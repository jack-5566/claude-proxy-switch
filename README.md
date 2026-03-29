# Claude Proxy Switch

快速切换 Claude Code 不同中转/代理配置的命令行工具。

国内使用 Claude Code 客户端时，经常需要在不同的中转服务之间切换（火山引擎 Ark、自建中转等），这个工具可以让你一键切换。

## 功能特性

- 保存多个配置文件（profiles）
- 一键切换，自动修改 Claude Code 配置
- 自动备份，防止配置丢失
- 原子写入，不会损坏原有配置
- 保留其他配置，只更新环境变量

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

# 添加直连配置
claude-proxy add direct https://api.anthropic.com \
  --token sk-xxx \
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
- Claude Code 配置文件：`~/.claude/settings.local.json`
- 修改前会自动备份到：`~/.claude/settings.local.json.bak.<timestamp>`

## 工作原理

Claude Code 从 `~/.claude/settings.local.json` 的 `env` 字段读取环境变量配置，包括 `ANTHROPIC_BASE_URL` 等。

这个工具：
1. 把你的多个配置保存在 `~/.claude-profiles/profiles.json`
2. 当你切换时，把选中配置的环境变量合并到 Claude Code 的 `settings.local.json`
3. 原子写入保证不会损坏配置
4. 修改前自动备份

## 注意事项

- 配置文件包含你的 API token，工具会自动设置 0600 权限保护
- 切换后必须重启 Claude Code 才能生效
- 工具只会更新你在 profile 中定义的环境变量，其他配置会被保留

## License

MIT
