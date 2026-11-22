# NounKiller · 名词解释记忆工具

> 一个只做一件事的背诵工具：把「名词解释」背下来。

市面上的背单词 App 把「不认识」处理成「再看一遍」。NounKiller 参考贝壳英语的三级记忆评级，重做了最核心的回忆交互：**「不熟悉」不是把答案再读一次，而是把整段释义抹成只剩标点的排版骨架，靠点击逐字点亮把记忆重新拼出来。**

网页端、Android、iOS 共用同一套 `web/` 业务代码，两端原生壳只补系统集成（本地持久化、文件选择、返回键、安全区、键盘），没有第二份逻辑。

---

## 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Android | [`release/NounKiller-2.1.0.apk`](release/NounKiller-2.1.0.apk) | `minSdk 26`，签名可直接覆盖安装升级 |
| iOS | [`release/NounKiller-2.1.0.ipa`](release/NounKiller-2.1.0.ipa) | development 签名，只能装到打包账号登记过的设备 |
| 网页 | [`release/NounKiller-2.1.0-web.zip`](release/NounKiller-2.1.0-web.zip) | 纯静态包，解压即可用（不含云端账号） |

线上版本：<https://nounkiller.pages.dev>

## 三级回忆：核心交互

| 选择 | 反馈 | 下一步 |
| --- | --- | --- |
| 熟悉 | 直接展示完整释义 | 再点一次进入下一条 |
| 不认识 | 直接展示完整释义 | 再点一次进入下一条 |
| 不熟悉 | 隐藏所有汉字与字母，只保留标点、换行；每个字是一个占位块，点哪里就点亮该字和设定的相邻字数 | 反复点击逐步揭开，也可以「全部显现」一次看全 |

点亮规则：默认前后各 1 字，标点隔断、不跨标点；英文和数字按整词处理。设置里可切成「仅本字 / ±1 字 / ±2 字」。

快捷键：`1` 不认识、`2` 不熟悉、`3` 熟悉；`空格 / Enter` 下一条；`←` 上一条；`Esc` 退出划线 / 擦除并关闭弹层。

## 功能

**题库**

- 导入 `txt`：名词一行 + 解释若干行、逐行「名词：解释」、名词带序号（`1.` / `（1）` / `一、`）三种写法可混用，条目之间不需要空行；解释内部的短句不会被误切成新名词。
- 导入 `json`：数组、`{cards:[…]}`、`{"名词":"解释"}`、JSONL 都认。
- 导入 `PDF` / `DOCX` / 截图：PDF 与 Word 直接抽文字，截图走本地 OCR 识别中文，结果按 txt 同一套规则切条，导入前可预览和修改。
- 多题库：切换、新建、重命名、删除、重置进度；「总收藏题库」固定置顶，汇总所有题库里星标的词条。

**记忆**

- 间隔重复：熟悉 → 间隔按 ease 递增（1 → 2 → 5 … 天，上限 365，日级排期落在本地 0:00，每晚刷新）；不熟悉 → 20 分钟后；不认识 → 10 分钟后。到期卡优先，新卡默认不限量（「每日目标」可改，0 为不限）。
- 划线高亮：全显时点「划线标记」，拖过文字松手即标记；荧光笔 / 横线 / 波浪线，黄绿粉三色；「擦除」清区间，「清空」清本卡。标记按字符区间存进词条，重启仍在。
- 回看与跳转：顶部「上一条」逐条回退，回退或从目录跳转后都重新从待评级开始；目录只列名词，点按跳转，收藏项置顶；全部结束可「重置本轮」。

**账号与协作（可选）**

- 邮箱 + 密码注册登录，登录后题库、词条、SRS 进度、划线、收藏、设置同步到云端；换设备登录会静默合并云端与本机数据，本机新增入库、云端数据不被覆盖。
- 不登录时一切只在本机，原有体验不变。
- 留言：登录用户可给管理员留言（8 秒轮询回复），未读在账号按钮上显示红点。
- 题库群组：建群（自动生成 8 位唯一群号）、群号申请、邮箱邀请、群聊、群文件分享整个题库；群设置里可看成员、审批入群、改名、移出成员，群主退出自动转给最早加入的成员。群列表与聊天内容本地缓存，进群先显示上次内容再静默拉取。

## 本地预览

只背题、不登录，静态服务器就够：

```bash
cd web && python3 -m http.server 5199
# 打开 http://127.0.0.1:5199/
```

要联调账号 / 云同步 / 留言，需要带 D1 的 Pages 运行时：

```bash
npx wrangler pages dev web --port 8788 --d1=DB --compatibility-date=2026-01-01
# 打开 http://127.0.0.1:8788/
```

直接双击 `web/index.html` 也能背（无构建、无外部依赖），账号相关请求走线上 API。

## 构建

```bash
./tool/build.sh          # 测试 + 网页 + APK + IPA
./tool/build.sh web      # 只出 build/latest/dist/
./tool/build.sh apk
./tool/build.sh ipa
./tool/build.sh test
./tool/build.sh clean    # 只清 .cache/
```

- Android：AGP 8.13.0 + Gradle 8.14.3，`minSdk 26 / targetSdk 36`，release 用仓库外的本地 keystore 签名。
- iOS：xcodegen 生成工程，自动签名，development 方式导出 IPA。
- 构建前会把 `web/` 同步进两端壳内；产物落在项目根的 `build/latest/`，同名旧产物自动进 `build/history/`。

## 目录

```
NounKiller/
├── build/                 # 可交付产物（不在版本库内）
│   ├── latest/            # 当前 apk、ipa、dist/
│   └── history/           # 旧版本自动归档
├── src/                   # ← 版本库根
│   ├── web/               # 唯一业务源：index.html + css/ + js/
│   │   └── _worker.js     # Pages Advanced Mode：/api 后端 + 静态资源兜底
│   ├── server/schema.sql  # D1 表结构参考
│   ├── android/           # 原生壳：WebView + SharedPreferences 桥
│   ├── ios/               # 原生壳：WKWebView + UserDefaults 桥
│   ├── test/run.mjs       # 核心逻辑测试（node:test）
│   ├── release/           # 当前版本的 apk / ipa / 网页包
│   └── tool/build.sh      # 构建入口
└── .cache/                # 截图、临时导出，可随时清空
```

## 云端后端

后端不引入第三方账号体系，直接跑在同一个 Pages 项目里。

- `web/_worker.js`：Pages Advanced Mode 单文件 Worker，`/api/*` 由它处理，其余请求 `env.ASSETS.fetch` 回静态资源。
- `server/schema.sql`：D1 表结构（users / sessions / user_data / messages / chat_*，users 含 `deleted_at` 软删除），首次请求也会 `CREATE TABLE IF NOT EXISTS` 并补列。
- 认证：PBKDF2-SHA256（100k 次，Workers WebCrypto 上限）+ 随机盐；会话只把 SHA-256 令牌摘要存 D1，有效期 60 天；Bearer Token，无 Cookie。
- 同步：每个用户一份 JSON 快照，`PUT /api/me/data` 带 `baseVersion` 做乐观锁，冲突返回 409 与云端数据。
- 在线状态：前台每 30 秒心跳，90 秒内有心跳记为在线。
- 管理员：只认 `ADMIN_EMAILS` 环境变量（逗号分隔）命中的邮箱，没有「首个注册用户自动管理员」。

部署步骤：

1. Cloudflare 控制台建 D1 数据库（如 `nounkiller`），记下 Database ID。
2. Pages 项目 → Settings → Functions → D1 bindings：变量名 `DB`，选中该库（Production 与 Preview 都加）。
3. 环境变量加 `ADMIN_EMAILS=你的管理员邮箱`（必填，否则没人能进管理后台）。
4. 注册通知走 QQ 邮箱 SMTP（`smtp.qq.com:465`）：开启 POP3/SMTP 并生成授权码，作为 Secret 配 `QQ_SMTP_USER` 与 `QQ_SMTP_PASS`；普通变量 `MAIL_FROM_NAME=NounKiller`。未配置时注册仍成功（只是不发通知），`/api/health` 的 `mail` 为 false。
5. 推送分支后 Pages 自动重新部署；首次访问 `/api/health` 应返回 `{"ok":true,"cloud":true,"mail":true}`。

注册只发通知邮件，不需要点链接验证；忘记密码时输入注册邮箱收 6 位验证码（10 分钟有效，60 秒内不重发）。管理员可在后台注销账号：立即踢下线并保留云端数据 7 天，期内用同一邮箱重新注册即可恢复完整题库、进度与划线，7 天后自动清除。

## 已知边界

- 不登录时数据只在本机，登录后才同步；云端是整份快照，换设备以最后一次同步为准，冲突时让你选云端或本机。
- 原生 App 登录走线上 `https://nounkiller.pages.dev` API，需要联网；不登录时完全离线可用。
- iOS 产物是 development 签名，只有打包账号登记过的设备能装；上架需换 App Store 分发配置。
- iOS 壳未在本机真机 / 模拟器跑过，网页逻辑已在桌面、移动视口与 Android WebView 验证。

## 说明

个人项目，仓库公开用于交流与参考，未附开源许可证（默认保留所有权利）；要复用代码或素材请先联系作者。
