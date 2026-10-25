# ASTRAL · 终端星河

在终端里聊天、开黑、传文件。用 ASCII 拼出来的木星土星会自己转，旁边有星野、流星和星云。

不需要图形界面，不需要账号，不需要服务器。三台机器连同一个 WiFi（或者同一个手机热点）就能直接通信，**端到端加密**。

```console
$ npm install -g astral
$ astral
```

<p align="center">
  <img src="docs/preview.gif" alt="preview" width="640">
</p>

---

## 为什么做这个

网页 IM 太重，XMPP/Matrix 配起来麻烦，Discord/微信都要注册。而在终端里打字的人其实一直都有——只是没有一个**好看、能玩、能加密**的选择。

ASTRAL 想做到三件事：

1. **打开就好看** —— 行星、星野、渐变，全部由字符拼成
2. **连上就能用** —— 零配置，同一网络自动发现房间
3. **聊天之外还能玩** —— 投票、传文件、狼人杀、三国杀、大富翁

---

## 特性

| | |
|---|---|
| 🪐 **星际画面** | 木星、土星（带环）、火星、地球、海王星、天王星、水星、金星，全部手写 ASCII 渲染 |
| ✨ **动态背景** | 视差星野、流星、星云、暗角，随行星缓慢自转 |
| 🔍 **零配置发现** | UDP 广播 + 组播，同 WiFi / 同热点自动出现房间列表 |
| 🔐 **端到端加密** | X25519 密钥交换 + AES-256-GCM，服务器只转发密文，看不到任何内容 |
| 👥 **千人房间** | 星型拓扑（Hub），O(n) 而非 O(n²)，支持 1000 人 |
| 💬 **仿 VK 群聊** | 彩色昵称、@ 补全、私聊、打字提示、消息高亮 |
| 📎 **文件传输** | 分片传输，SHA-256 校验，哈希不符直接丢弃 |
| 📊 **投票** | 单选/多选，可匿名，实时票数条 |
| 🎮 **三款桌游** | 狼人杀、三国杀、大富翁跳棋，全部确定性可重放 |
| 🧩 **插件传输** | 蓝牙为可选插件，装不上就自动降级，不影响主功能 |
| 🖥️ **全平台** | Windows 10+ / macOS / Linux，无原生依赖 |

---

## 快速开始

### 安装

```console
# 任选其一
npm install -g astral          # npm
pnpm add -g astral             # pnpm
yarn global add astral         # yarn
```

> Node.js ≥ 18 即可。**运行时零依赖**——安装很快，也不会有供应链风险。

### 第一个房间

```console
# 主机 A
$ astral host --room 星际酒馆 --pass 星辰大海

# 主机 B（同一个 WiFi / 热点下）
$ astral
# ↑↓ 选择房间，回车加入
```

### 直接加入

```console
$ astral join 星际酒馆 星辰大海 --hub 192.168.1.5:7331
```

或者用邀请码（发给朋友即可，含房间口令）：

```console
$ astral invite 星际酒馆 --hub 192.168.1.5:7331
  邀请码：ASTRAL1:eyJ2IjoxLCJuYW1lIjoi...
```

---

## 命令

### 聊天时输入

| 命令 | 作用 |
|---|---|
| `/help` | 帮助 |
| `/nick 名字` | 改昵称 |
| `/dm 某人 内容` | 私聊（端到端加密） |
| `/members` | 在线成员 |
| `/send 文件路径` | 发文件 |
| `/poll "问题" A\|B\|C` | 发起投票 |
| `/vote 2` | 投票给第 2 项 |
| `/game werewolf` | 开局：`werewolf` / `sanguosha` / `monopoly` |
| `/act 杀 张三` | 游戏内行动 |
| `/theme ember` | 换主题：`nebula` / `ember` / `ice` / `mono` |
| `/planet saturn` | 换装饰行星 |
| `/quit` | 离开 |

### 快捷键

`Enter` 发送 · `↑↓` 历史/滚动 · `Tab` 补全昵称 · `Ctrl+W` 删词 · `Ctrl+L` 清屏 · `Ctrl+C` 退出

### CLI

```console
astral                          # 交互模式
astral host --room 名称 --pass 口令
astral join 房间名 [口令] [--hub 主机:端口]
astral rooms                    # 扫描局域网
astral id                       # 身份指纹 + randomart
astral invite 房间名
astral demo                     # 离线演示
astral art saturn               # 只画行星
```

常用选项：`--nick` `--theme` `--planet` `--port` `--no-color` `--bt`（蓝牙）

---

## 三款桌游

### 🐺 狼人杀（6–12 人）

预女猎白 + 守卫，昼夜循环，毒药解药，猎人开枪，平票流放。

```console
/game werewolf
```

### ⚔️ 三国杀（4–8 人）

主公 / 忠臣 / 反贼 / 内奸身份局，15 名武将各带技能，杀闪桃 + 南蛮 / 万箭 / 决斗 / 无懈 / 顺手牵羊 / 过河拆桥。手牌只有你自己能看到。

```console
/game sanguosha
```

### 🎲 大富翁跳棋（2–8 人）

掷骰走子、购地收租、建房升级、机会卡、星税、入狱、破产出局。

```console
/game monopoly
```

**为什么游戏能多人同步？** 所有随机数都由 `rngSeed` 驱动（xoshiro128\*\*），不用 `Math.random()`。动作历史就是回放——同一份记录在任何机器上跑出来的结果完全一致。

---

## 加密怎么做的

```
你的机器                                Hub（只转发密文）             朋友的机器
   │                                        │                            │
   ├─ PBKDF2(房间口令) ──> 房间密钥 ─────────┤                            │
   │                                        │                            │
   ├─ 私聊：X25519 临时密钥对                │                            │
   │   └─ ECDH + HKDF ──> 成对密钥            │                            │
   │                                        │                            │
   └─ AES-256-GCM 加密                       │                            │
       (AAD 绑定房间 ID)                     │                            │
       ── 密文 ─────────────────────────────>│──── 密文 ─────────────────>│
                                            │                              └─ 解密
```

- **身份**：Ed25519 密钥对，peer id = `base32(sha256(公钥))` 前 16 位，本地生成不上传
- **房间密钥**：PBKDF2-SHA256，31 万次迭代，口令永不离开你的机器
- **私聊**：双层加密——内层成对密钥（ECDH），外层房间密钥。连"谁在跟谁说话"都藏起来
- **每条消息**：AES-256-GCM，AAD 绑定房间 ID，防止密文被搬到别的房间重放
- **首次连接**：比对 randomart 指纹图即可确认没有被中间人替换

```console
$ astral id
  指纹 K7QP 3NM2 XR8A ...
  +-----------------+
  | .o*=+..   .+*o. |   ← 和朋友核对这张图
  | =%#@*..  ..o@#= |
  +-----------------+
```

---

## 蓝牙传输（可选）

蓝牙作为**插件式传输层**，默认不装也不影响任何功能：

```console
$ npm install -g astral bluetooth-serial-port @abandonware/noble
$ astral --bt
```

- Windows / Linux：RFCOMM 串口（`bluetooth-serial-port`）
- macOS：BLE GATT（`@abandonware/noble`）
- 没装依赖、没开蓝牙、没有适配器 → 自动降级并提示，主功能照常

---

## 开发

```console
git clone https://github.com/yourname/astral.git
cd astral
pnpm install          # 只装 typescript（运行时零依赖）
pnpm build
pnpm test
pnpm dev
```

### 项目结构

```
src/
  lib/          ANSI 色彩 / Frame 字符画布 / 噪声 / RNG / 终端能力探测 / 富文本宽度
  render/       行星渲染 / 星野 / 开机动画 / Logo
  crypto/       Ed25519 身份 / X25519 ECDH / AES-GCM / randomart / 邀请码
  net/          二进制协议 / TCP / 发现（广播+组播）/ Hub / Peer / 蓝牙适配器
  games/        确定性引擎 + 狼人杀 / 三国杀 / 大富翁
  features/     文件传输 / 投票
  ui/           TUI 控件 / 键盘解析 / 主界面
  cli/          参数解析 / 交互循环 / 子命令
```

### 测试

```console
pnpm test        # 39 个单元测试：宽度/ANSI、Frame、加解密、协议、RNG、三款游戏
pnpm smoke       # 真 TCP 建 hub + 3 peer，跑通握手/群聊/DM
pnpm sim         # 三款游戏自动对局到结束，验证状态机不会卡死
pnpm e2e         # 全流程：host -> join -> 群聊/DM/文件/投票/游戏（8 项断言）
```

当前状态：**39/39 单元测试、3/3 游戏对局、8/8 端到端**全部通过。

---

## 设计取舍

| 决策 | 理由 |
|---|---|
| **星型拓扑而非 P2P 网格** | 1000 人时 P2P 需要 ~50 万条连接；星型只要 1000 条。Hub 只转发密文，看不到内容 |
| **广播发现而非中心服务器** | 没有服务器就没有单点故障，也不用注册。代价是跨网段要手动指定 `--hub` |
| **游戏不用 Math.random()** | 否则每个人算出的局面不一样。种子驱动让任何设备能重放同一局 |
| **运行时零依赖** | 供应链风险 + 安装速度。ANSI、TUI、噪声全部手写，只留 typescript 作 devDep |
| **蓝牙做成插件** | 原生依赖在三个平台都难装。装不上不影响 LAN 功能，装得上就多一条路 |
| **字符画布而非流式输出** | 流式 `console.log` 会闪烁。整帧渲染 + diff 输出，动画才流畅 |

---

## 已知限制

- 跨网段（不同 WiFi）不能自动发现，用 `--hub` 手动指定
- 蓝牙实测仅在 Linux 完整验证过（macOS 需要额外权限弹窗）
- 三国杀是简化版：15 名武将各 1 个技能，不含扩展包
- 千人房间未做压测；星型拓扑理论上限 1000，实际取决于 Hub 机器带宽

---

## License

MIT
