# 🐻 单词小乐园 · 英语单词练习

小学生英语单词练习乐园：单词本 + 学习 / 拼写 / 复习 / 考试 / 配对游戏，真人发音、间隔复习、游戏化激励。

- **纯静态、纯前端**，无需后端与数据库。
- **数据默认只存在浏览器 localStorage**；可选开启 **Cloudflare KV 云端同步**，在多设备共享同一份单词本与错题本。
- 一键部署到 **Cloudflare Pages**（免费额度自用完全够）。

## 功能一览

| 模块 | 说明 |
|------|------|
| 📚 单词本 | 增删单词、搜索、分类过滤、导入/导出 JSON、一键示例词库、✨自动查（联网查中文/音标/例句，失败可手填） |
| 🎓 学习 | 翻牌卡（前英后中）、真人发音、🐢 慢速跟读、进度条 |
| ✍️ 拼写 | 看中文拼英文 / 听音拼写，逐字母提示，错词自动记录 |
| 🔄 复习 | 轻量 SM-2 间隔复习，优先练最生疏的词，自评记住/没记住 |
| 📝 考试 | 自动出选择题（中→英 / 英→中），计分 + 错题回顾 |
| 🎮 配对 | 英文↔中文配对消除，全部完成有奖励 |
| 📕 错题本 | 自动收集拼写拼错 / 考试选错 / 复习没记住 / 配对连错，持久记录你的错误作答与正确答案；支持按模式筛选、搜索、逐条「去巩固」(复用复习·仅错词)、标记攻克、移除、清空；单词被掌握后错题自动标为已攻克 |
| 🏆 激励 | 星星积分、连续打卡、10 项成就徽章（含错题相关） |

## 本地预览

在本目录下起一个静态服务器即可（任选其一）：

```bash
# Python
python -m http.server 8080
# 然后浏览器打开 http://localhost:8080

# 或 Node
npx serve .
```

> 直接双击 `index.html` 也能用，但部分浏览器对 `file://` 下的 fetch（自动查）有限制，建议用本地服务器。

## 部署到 Cloudflare Pages（关联 GitHub 自动部署）

1. 把本目录推送到一个 GitHub 仓库。
2. 登录 <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
3. 选择该仓库，构建配置如下：
   - **Framework preset**: `None`
   - **Build command**: 留空
   - **Build output directory**: `/`（仓库根目录，即含 `index.html` 的一层）
4. 点击 **Save and Deploy**，几十秒后得到 `https://<你的项目名>.pages.dev`。
5. 之后每次 `git push`，Cloudflare 会自动重新构建部署。

### 备选：命令行直传（无需 GitHub）

```bash
npx wrangler pages deploy . --project-name=word-land
```

## 多端同步（Cloudflare KV）

在「单词本」标签页的 **☁️ 云端同步** 面板里，设置一个**同步口令**并开启自动同步，即可在手机/电脑/平板上共享同一份数据。无需注册账号，多台设备用同一个口令即可。

### 原理
- 同步后端是仓库里的 `functions/api/sync.js`（Cloudflare Pages Function）。
- 数据存 Cloudflare **KV**：key 由「同步口令的 SHA-256」派生，云端不存明文口令。
- 冲突策略：**后写覆盖（last-write-wins）**，按 `updated_at` 时间戳调和。个人自用、通常不同时改，足够稳妥。
- 同步额度：KV 免费 10 万读/天、1000 写/天、1GB，自用完全够。

### 一次性后台配置（约 2 分钟）
1. Cloudflare 控制台 → **Storage & Databases** → **KV** → 新建命名空间，命名为 `wordland-sync`。
2. 你的 Pages 项目 → **Settings** → **Functions** → **KV namespace bindings** → 添加绑定：
   - 变量名（Variable name）：`WORDLAND_SYNC`
   - 选择刚建的命名空间。
3. 配置好后 `git push` 一次，Pages Function 即生效（函数文件随仓库部署，KV 绑定需在后台手动加）。

> 本地用 `wrangler pages dev` 测试时，需在 `wrangler.toml` 里给 `WORDLAND_SYNC` 绑定一个本地 KV 命名空间 ID。

### 使用
- 设备 A：填入口令 → 开启同步 → 数据自动上传云端。
- 设备 B：填**同一个**口令 → 开启同步 → 自动拉取 A 的数据。
- 之后任意设备的改动都会在保存后约 1.5 秒自动同步；也可点「🔄 立即同步」手动触发。

## 目录结构

```
word-land/
├── index.html            # 页面结构
├── style.css             # 样式（童趣、响应式）
├── app.js                # 全部交互逻辑（localStorage + 云端同步）
├── functions/
│   └── api/sync.js       # Cloudflare Pages Function：拉取/推送同步数据（KV 后端）
├── _headers              # Cloudflare Pages 安全/缓存头
├── .gitignore
└── README.md
```

## 隐私说明

默认所有单词与学习进度只存在你自己的浏览器里（localStorage），不上传任何服务器。只有在「☁️ 云端同步」面板**主动开启同步并填写口令**后，数据才会经 Cloudflare KV 在多设备间同步；云端 key 由口令哈希派生，数据以明文存储于你的 KV 命名空间（站点强制 HTTPS，仅持有口令者可定位）。如需更强隐私，可自行在 `app.js` 加入客户端加密（以口令为密钥的 AES）。换设备/清缓存前可用「导出」备份 JSON。
