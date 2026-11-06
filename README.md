# NounKiller · 名词解释记忆工具

一个只做一件事的背诵工具：把「名词解释」背下来。参考贝壳英语的三级记忆评级，重做了核心回忆交互——「不熟悉」不是再看一遍，而是把全文变成只剩标点的排版骨架，靠点击逐字点亮回忆。

网页端、Android、iOS 共用同一套 `src/web` 业务代码，两端原生壳只补系统集成（本地持久化、文件选择、返回键、安全区、键盘）。

## 三级回忆交互

| 选择 | 反馈 | 下一步 |
| --- | --- | --- |
| 熟悉 | 直接展示完整释义 | 再点一次进入下一条 |
| 不认识 | 直接展示完整释义 | 再点一次进入下一条 |
| 不熟悉 | 隐藏所有汉字/字母，保留标点与换行；每字是占位块，点哪里点亮该字及设置的相邻字数（默认前后各 1 字，标点隔断，不跨标点；英文/数字按整词） | 反复点击逐步揭开，也可「全部显现」一次看全 |

快捷键：`1` 不认识、`2` 不熟悉、`3` 熟悉；`空格 / Enter` 下一条；`←` 上一条；`Esc` 退出划线/擦除并关闭弹层。

## 其他能力

- **导入题库**：`txt` 支持三种写法，条目之间可以没有空行：
  - 名词一行、解释若干行（靠「短行 + 下一行像解释」判断新名词，解释内部短句不会被误切）；
  - 逐行「名词：解释」；
  - 名词前带序号（`1.` / `（1）` / `一、`）时，序号本身就是分条标记，不需要空行。
  另支持 `json`（数组、`{cards:[…]}`、`{"名词":"解释"}`、JSONL）。
- **文档与截图识别**：导入时也可选 `PDF`、`DOCX` 或图片（截图）。PDF/Word 直接抽取文字，截图用本地 OCR 识别中文；识别结果按与 `txt` 相同的排版规则切条，导入前可预览与修改。
- **划线高亮**：全显时点「划线标记」，拖过文字松手立即标记（再点一次结束并保存）；可在设置里选荧光笔 / 横线 / 波浪线，以及黄、绿、粉三种颜色；「擦除」拖动清除指定区间的标记，「清空」清空本卡全部标记。标记按字符区间存进词条，重启后仍在。
- **间隔重复**：熟悉 → 间隔按 ease 递增（1→2→5…天，上限 365），日级排期统一落在本地 0:00，每晚自动刷新；不熟悉 → 20 分钟后；不认识 → 10 分钟后。到期卡优先，新卡默认不限量（设置「每日目标」可改，0 为不限）。
- **点亮范围**：设置里可选「仅本字 / ±1 字 / ±2 字」，默认前后各 1 字。
- **回看与跳转**：顶部「上一条」逐条回退，回退或从「目录」跳转后都重新从待评级开始；目录只列名词，点按即可跳转；收藏的名词在目录里置顶为「收藏」，其余按原顺序接续编号，取消收藏后自动补齐；全部结束后可用「重置本轮」把当前题库重新过一遍。
- **多题库**：切换、新建、重命名、删除、重置进度；「总收藏题库」固定置顶，汇总所有题库里点亮星标的词条，点开即可集中背诵。
- **账号与云端（可选）**：邮箱 + 密码注册/登录。登录后题库、词条、SRS 进度、划线、收藏、设置同步到云端；换设备登录会询问「载入云端 / 用本机覆盖」。不登录时一切仍只在本机，原有体验不变。
- **留言与管理员后台**：登录用户可给管理员留言（8 秒轮询回复）；管理员账号能看到注册用户列表、在线状态、题库/词条/收藏数量与未读留言，并可逐个用户回复。未读在顶部账号按钮上有红点。

## 目录

```
NounKiller/
├── build/
│   ├── latest/          # 当前产物：apk、ipa、dist/（网页）
│   └── history/         # 旧版本自动归档
├── src/
│   ├── web/             # 唯一业务源：index.html + css/ + js/（core/store/app/account）
│   │   └── _worker.js   # Pages Advanced Mode：/api 后端 + 静态资源兜底
│   ├── server/schema.sql# D1 表结构参考
│   ├── android/         # 原生壳：WebView + SharedPreferences 桥
│   ├── ios/             # 原生壳：WKWebView + UserDefaults 桥（xcodegen 工程描述）
│   ├── test/run.mjs     # 核心逻辑测试（node:test）
│   └── tool/build.sh    # 构建入口
└── .cache/              # 可删缓存与检查截图
```

## 本地预览

只背单词（不登录）时，静态服务器即可：

```bash
cd src/web && python3 -m http.server 5199
# 打开 http://127.0.0.1:5199/
```

要联调账号 / 云同步 / 留言，需要带 D1 的 Pages 运行时：

```bash
cd src && npx wrangler pages dev web --port 8788 --d1=DB --compatibility-date=2026-01-01
# 打开 http://127.0.0.1:8788/
```

直接双击 `src/web/index.html` 也能背（无构建、无外部依赖）；账号相关请求会走线上 API。

## 构建

```bash
./src/tool/build.sh          # 测试 + 网页 + APK + IPA
./src/tool/build.sh web      # 只出 build/latest/dist/
./src/tool/build.sh apk
./src/tool/build.sh ipa
./src/tool/build.sh test
./src/tool/build.sh clean    # 只清 .cache/
```

- Android：AGP 8.13.0 + Gradle 8.14.3，`minSdk 26 / targetSdk 36`，release 用仓库内 `src/android/app/nounkiller.keystore` 签名。
- iOS：xcodegen 生成工程，自动签名（Team `UQ6YYY43ZY`），development 方式导出 IPA。
- 构建前会把 `src/web` 同步到两端壳内，产物落 `build/latest/`，同名旧产物自动进 `build/history/`。

## 后端（Cloudflare Pages + D1）

后端不引入第三方账号体系，直接跑在同一个 Pages 项目里：

- `src/web/_worker.js`：Pages Advanced Mode 单文件 Worker。`/api/*` 由它处理，其余请求 `env.ASSETS.fetch` 回静态资源。
- `src/server/schema.sql`：D1 表结构（users / sessions / user_data / messages；users 含 `deleted_at` 软删除），Worker 首次请求也会 `CREATE TABLE IF NOT EXISTS` 并补列。
- 认证：PBKDF2-SHA256（100k 次，Workers WebCrypto 上限）+ 随机盐；会话只把 SHA-256 令牌摘要存 D1，有效期 60 天；Bearer Token，无 Cookie。
- 同步：每个用户一份 JSON 快照，`PUT /api/me/data` 带 `baseVersion` 做乐观锁，冲突返回 409 与云端数据。
- 在线状态：前台每 30 秒心跳，90 秒内有心跳记为在线；管理员列表 20 秒刷新。
- 管理员：只认 `ADMIN_EMAILS` 环境变量（逗号分隔）命中的邮箱，注册后自动成为管理员；不再有「首个注册用户自动管理员」，避免公开站点被抢注。部署前先配置 `ADMIN_EMAILS`。

部署步骤：

1. 在 Cloudflare 控制台创建 D1 数据库（名称随意，如 `nounkiller`），记下 Database ID。
2. Pages 项目 `nounkiller` → Settings → Functions → D1 bindings：变量名填 `DB`，选中该数据库（Production 与 Preview 都加）。
3. Pages 项目环境变量加 `ADMIN_EMAILS=你的管理员邮箱`（逗号分隔，必填，否则没有人能进管理后台）。
4. 注册通知走 QQ 邮箱 SMTP（`smtp.qq.com:465`，与 Anyu 同一方式）：
   - QQ 邮箱 → 设置 → 账户 → 开启 POP3/SMTP → 生成授权码；
   - Pages 项目 → Settings → Variables and Secrets 添加 **Secret** `QQ_SMTP_USER=2164206282@qq.com` 与 `QQ_SMTP_PASS=授权码`；普通变量 `MAIL_FROM_NAME=NounKiller`。
   - 未配置授权码时注册仍成功（不发通知），`/api/health` 的 `mail` 为 false。
5. 推送 `1.2` 分支，Pages 会自动重新部署；首次访问 `/api/health` 应返回 `{"ok":true,"cloud":true,"mail":true}`。
6. 打开网页右上角账号按钮注册；管理员邮箱注册后账号面板会出现「管理后台」。

注册只发通知邮件，不需要点链接验证；忘记密码时输入注册邮箱，系统自动发送 6 位验证码（10 分钟有效，60 秒内不重发），输入验证码即可重置密码。管理员可在管理后台注销账号：立即踢下线并保留云端数据 7 天，用户 7 天内用同一邮箱重新注册即可设置新密码并恢复完整题库、进度、划线与收藏；7 天后数据自动清除。

## 已知边界

- 不登录时数据仍只在本机；登录后才同步。云端数据是整份快照，换设备以最后一次同步为准；冲突时会让你选云端或本机。
- 原生 App（Android/iOS）登录走线上 `https://nounkiller.pages.dev` API，因此需要联网；不登录时完全离线可用。
- iOS 产物是 development 签名，只有打包所用开发者账号登记过的设备可直接安装；上架需换成 App Store 分发配置。
- iOS 壳未在真机/模拟器上跑过（本机无可用模拟器运行时），网页逻辑已在桌面、移动视口与 Android WebView 验证。
