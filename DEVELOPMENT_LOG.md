# Jacky Image Studio 开发维护日志

> **2026-07-28 ????????**?Jacky Image ???????????PWA?Docker ??????????????????????????PWA??Docker ????????????????????????Next.js ??????? Electron ?????????????? Electron ??????
>

> **用途**：记录项目架构、源码归属、Electron 改造决策、构建流程和禁止事项，防止后续直接修改生成文件、重复踩坑或破坏网页版与桌面版共用结构。
>
> **当前项目根目录**：`E:\ai网站\image studio`
>
> **最后更新**：2026-07-27

---

## 1. 开发时先记住的六条规则

1. **所有功能修改都在项目源码中完成，禁止修改安装包、ZIP、`build/`、`out/`、`release/` 中的文件。**
2. **网页版和 Electron 版共用同一套前端与后端，不要复制出第二套业务代码。**
3. **Electron 正式版仍通过本地 HTTP 服务运行，不要改成直接加载 `file://`。** 前端的相对 API、WebSocket 和同源逻辑依赖该结构。
4. **后端依赖只添加到 `backend/package.json`，Electron/打包工具只添加到根 `package.json`。** 不要把 `better-sqlite3` 等后端原生依赖加回根依赖。
5. **SQLite、生成图片和日志必须写入 `%APPDATA%/Jacky Image/`，禁止写入安装目录或 `resources/`。**
6. **发布前只认 `npm run desktop:make` 生成的 `release/`，不要手工拼装安装包。**

---

## 2. 当前架构

```text
Electron 主进程
├── 创建 BrowserWindow
├── 分配 127.0.0.1 随机端口
├── 启动随包附带的 Node.js 运行时
│   └── 运行 backend/server.js
├── BrowserWindow 打开 http://127.0.0.1:<随机端口>
└── 退出时调用带令牌的桌面关闭接口

Node.js 后端
├── 托管 frontend/out 静态文件
├── /api/jacky/*
├── /api/jacky/ws
├── SQLite 任务数据库
└── 本地图片目录
```

### 为什么不使用 `file://`

当前前端大量使用以下相对地址：

```text
/api/jacky/tasks
/api/jacky/proxy/text
/api/jacky/queue-status
/api/jacky/ws
```

使用本地 HTTP 服务可以继续保持同源请求、WebSocket 和网页版一致的行为。如果改成 `file://`，需要重新设计 API 地址、WebSocket 地址、安全策略和资源路径，因此不要随意改变。

### 为什么桌面包里附带独立 Node.js

后端使用 `better-sqlite3`，它是原生 Node 模块。如果直接让 Electron Node 运行后端，需要处理 Electron ABI 重编译，并要求构建机安装 Visual Studio C++ Build Tools。

当前方案把构建机正在使用的 Node.js 和对应的后端生产依赖一起放入：

```text
resources/desktop-runtime/
├── node.exe
├── node_modules/
├── backend/
└── frontend/out/
```

这样最终用户不需要安装 Node.js，也避免 `better-sqlite3` 的 Electron ABI 不兼容问题。

---

## 3. 哪些文件才是源码

| 修改目标 | 源码位置 | 说明 |
|---|---|---|
| 页面、样式、React 组件 | `frontend/src/` | 网页版和 Electron 共用 |
| 前端依赖 | `frontend/package.json`、`frontend/package-lock.json` | 不要改构建产物 |
| 前端静态导出配置 | `frontend/next.config.ts` | 桌面构建会关闭 PWA |
| API、任务队列、WebSocket、SQLite | `backend/server.js` | 网页版和 Electron 共用 |
| 提示词与黑名单 | `backend/prompts.json`、`backend/blacklist.json` | 会复制到桌面运行环境 |
| 后端依赖 | `backend/package.json`、`backend/package-lock.json` | `desktop:prepare` 按此安装生产依赖 |
| Electron 窗口、菜单、日志、后端启停 | `electron/main.cjs` | 桌面主进程入口 |
| 前端可访问的安全桌面桥接 | `electron/preload.cjs` | 不要开启 `nodeIntegration` |
| Windows 打包配置 | `forge.config.cjs` | Squirrel、ZIP、忽略规则、输出目录 |
| Electron 图标生成 | `scripts/generate-electron-icon.mjs` | 由 PNG 生成 ICO |
| 桌面后端运行环境准备 | `scripts/prepare-electron-runtime.mjs` | 复制 Node、后端依赖和静态前端 |
| 发布文件收集 | `scripts/collect-electron-artifacts.mjs` | 把 Forge 结果复制到 `release/` |
| 开发和发布命令 | 根 `package.json` | Electron 和 Forge 属于开发依赖 |

---

## 4. 禁止直接修改的目录

下面全部是生成物或运行数据，修改后会在下一次构建时丢失。

| 目录 | 用途 | 正确做法 |
|---|---|---|
| `frontend/out/` | Next.js 静态导出 | 修改 `frontend/src/` 后重新构建 |
| `build/` | 图标、Electron 缓存、桌面运行环境 | 执行 `npm run desktop:prepare` |
| `out/` | 旧的或临时 Forge 输出 | 不作为发布来源，可安全重新生成 |
| `release/` | 最终安装包和便携 ZIP | 只用于交付，不在其中开发 |
| `C:\Users\Public\JackyImageBuild/` | ASCII 路径的 Forge 原生构建目录 | 由脚本管理，不手改 |
| `%APPDATA%/Jacky Image/` | 用户数据库、图片和日志 | 只用于运行数据和排障 |
| `node_modules/` | 安装依赖 | 修改 package 文件后重新安装 |

### 特别警告：不要删除 ASCII 构建目录方案

项目路径包含中文。Squirrel 使用的旧版 `rcedit.exe` 在中文路径下修改 `Setup.exe` 资源时曾出现：

```text
Fatal error: Unable to load file
```

因此 `forge.config.cjs` 会把原生构建临时目录放到：

```text
C:\Users\Public\JackyImageBuild
```

最终产物再复制回项目的 `release/`。除非已经验证新的安装包工具完全支持 Unicode 路径，否则不要删除这层处理。

---

## 5. 依赖应该加到哪里

### 前端依赖

在 `frontend/` 中安装：

```bash
cd frontend
npm install <package>
```

### 后端运行依赖

在 `backend/` 中安装：

```bash
cd backend
npm install <package>
```

后端运行依赖包括：

```text
better-sqlite3
undici
ws
```

不要为了让 Electron 找到它们而把这些包加到根 `package.json`。桌面构建脚本会从 `backend/package-lock.json` 创建独立运行环境。

### Electron 和构建工具

只添加到根目录开发依赖：

```bash
npm install --save-dev <package>
```

例如：

```text
electron
@electron-forge/*
playwright
png-to-ico
```

### 为什么根目录不放运行依赖

Forge 打包时会忽略根 `node_modules/`。如果把后端依赖重新加到根依赖并放开该忽略规则，会把开发工具、缓存甚至旧安装包一起塞入 `app.asar`。

曾经因为未忽略根 `node_modules/` 和旧 `out/`，安装包异常增长到约 **886 MB**。修正后安装包约 **166 MiB**，便携 ZIP 约 **171 MiB**。

如果以后安装包突然大于约 250 MiB，优先检查：

```text
forge.config.cjs 的 ignore
根 node_modules 是否被打包
旧 out/ 和 release/ 是否被打包
resources/app.asar 的体积
```

---

## 6. 常用开发流程

### Windows 双击快捷启动器

项目根目录提供：

```text
启动 Jacky Image 开发版.cmd
```

双击后可选择：

1. 智能启动：检测前端或后端源码是否比桌面运行环境更新，需要时自动构建。
2. 快速预览：直接使用最近一次构建，不打开 DevTools。
3. 调试模式：使用最近一次构建并自动打开 DevTools。
4. 强制重新构建并调试。
5. 启动最终打包版。
6. 生成 Windows 安装包和便携 ZIP。
7. 查看运行日志。
8. 创建桌面快捷方式。

启动器的实际逻辑位于 `scripts/launch-desktop.ps1`。后续要调整启动流程时修改 PowerShell 脚本，不要把复杂逻辑堆到 `.cmd` 文件中。

`启动 Jacky Image 开发版.cmd` 必须保持 **ASCII 内容 + CRLF 换行**，不要在批处理文件中加入 `chcp 65001` 或中文提示。该项目路径包含中文，CMD 在 UTF-8/LF 批处理下曾把 `%~dp0` 和 `-ExecutionPolicy` 等命令拆坏，表现为双击后闪退。中文界面统一放在带 UTF-8 BOM 的 `scripts/launch-desktop.ps1` 中。

智能启动使用 `build/desktop-runtime/.prepared.json` 作为最近一次完整准备成功的时间标记。不要改回通过复制后文件的时间戳判断，因为 `server.js` 等文件可能保留原始修改时间，导致启动器每次都误判为需要重建。

当开发版仍在运行时，启动器会阻止覆盖 `build/desktop-runtime/`。由于关闭按钮现在只隐藏到托盘，必须在托盘菜单中选择“退出 Jacky Image”，避免 Windows 锁住 `better_sqlite3.node` 后造成 `EPERM unlink` 构建失败。

### 首次安装

```bash
npm install
cd frontend && npm ci && cd ..
cd backend && npm ci && cd ..
```

### 网页版开发

```bash
npm run dev:frontend
npm run dev:backend
```

### Electron 桌面开发

```bash
npm run desktop:dev
```

该命令当前会：

1. 使用 `JACKY_DESKTOP_BUILD=1` 构建静态前端。
2. 禁用桌面构建中的 PWA Service Worker。
3. 生成 Windows ICO。
4. 准备 `build/desktop-runtime/`。
5. 启动 Electron。
6. 开发环境自动打开 DevTools。

注意：当前桌面开发模式不是 HMR 模式，每次主进程或业务代码修改后需要重新运行命令。

### 只准备桌面构建内容

```bash
npm run desktop:prepare
```

### 生成未安装的桌面程序目录

```bash
npm run desktop:package
```

### 生成最终 Windows 安装包和 ZIP

```bash
npm run desktop:make
```

最终文件：

```text
release/
├── squirrel.windows/x64/Jacky-Image-Setup.exe
├── squirrel.windows/x64/jacky_image-<version>-full.nupkg
├── squirrel.windows/x64/RELEASES
└── zip/win32/x64/Jacky Image-win32-x64-<version>.zip
```

---

## 7. Electron 运行规则

### 本地端口

Electron 每次启动时自动获取空闲端口，并让后端只监听：

```text
127.0.0.1:<随机端口>
```

不要改回固定 `3000`，也不要在桌面版中监听 `0.0.0.0`，否则可能产生端口冲突或把本地服务暴露到局域网。

### 优雅退出

Electron 主进程生成随机控制令牌，并请求：

```text
POST /api/jacky/desktop/shutdown
X-Jacky-Desktop-Token: <随机令牌>
```

后端收到有效令牌后触发原有 SIGTERM 关闭流程：

1. 停止接收请求。
2. 关闭 HTTP 和 WebSocket。
3. 等待正在运行的任务。
4. 执行 SQLite WAL checkpoint。
5. 关闭数据库并退出。

该接口没有正确令牌时返回 `403`。不要把控制令牌暴露给渲染进程。

### 系统托盘与关闭行为

Windows 桌面版会在启动时创建系统托盘图标。点击窗口右上角关闭按钮时：

1. BrowserWindow 只执行 `hide()`，不会销毁。
2. Node.js 后端、任务队列和 WebSocket 继续运行。
3. 第一次隐藏时显示“仍在后台运行”的 Windows 托盘提示。
4. 单击或双击托盘图标可以恢复并聚焦窗口。

托盘右键菜单包含：

```text
打开 Jacky Image
打开开发者工具
查看运行日志
打开数据目录
退出 Jacky Image
```

只有选择“退出 Jacky Image”、使用应用菜单的 Quit，或触发明确的 `app.quit()` 时，才会运行后端优雅关闭和 SQLite checkpoint。

重要：关闭窗口现在不等于退出应用。重新构建桌面运行环境前，必须在系统托盘中选择“退出 Jacky Image”；否则 `better_sqlite3.node` 会被后台 Node 进程锁定并导致 `EPERM unlink`。

如果没有立刻看到托盘图标，先展开 Windows 任务栏右下角的“隐藏的图标”箭头。托盘图标使用 `build/icon.ico`，打包时该文件必须保留在应用资源中。

### Electron 安全设置

必须保持：

```javascript
nodeIntegration: false
contextIsolation: true
sandbox: true
webSecurity: true
```

需要增加本地文件、系统通知等桌面能力时，通过 `preload.cjs` 暴露最小 API，不要直接给网页 Node.js 权限。

### Windows 标题栏与桌面布局

Electron Windows 窗口使用：

```javascript
titleBarStyle: 'hidden'
titleBarOverlay: { height: 42, ... }
autoHideMenuBar: true
```

网页中的 `#jacky-desktop-titlebar` 是可拖动区域，`preload.cjs` 会给 `<html>` 添加 `data-jacky-desktop="true"`，因此这套标题栏和全宽布局只在 Electron 中生效，不影响浏览器部署。

注意事项：

- 不要删除 `-webkit-app-region: drag`，否则无边框标题栏区域无法拖动窗口。
- 标题栏右侧必须保留约 148px 空间，避免内容进入 Windows 最小化、最大化和关闭按钮区域。
- `preload.cjs` 会监听 `data-theme` 和系统主题，并通知主进程同步 `titleBarOverlay` 颜色；修改主题系统时要同时验证标题栏。
- Electron 桌面端通过 `.jacky-workspace-shell`、`.jacky-workspace-surface` 和 `.jacky-workspace-content` 移除外层大卡片、取消最大宽度并扩展为窗口工作区。
- 浏览器版本仍保留原有 `max-w-5xl` 和卡片容器，不要为了桌面效果直接删除通用 Tailwind 类；桌面差异统一写在 `html[data-jacky-desktop='true']` CSS 下。
- 原生 `File / View / Help` 菜单默认隐藏，可按 `Alt` 临时显示；DevTools 仍可通过 `F12`、`Ctrl+Shift+I` 或菜单打开。

### PWA

网页版可以继续使用 PWA；桌面构建通过：

```text
JACKY_DESKTOP_BUILD=1
```

关闭 Service Worker，避免 Electron 更新后仍加载旧前端缓存。不要在桌面构建中重新启用 PWA，除非已经验证更新缓存策略。

---

## 8. 数据、日志和排障

### 运行数据

```text
%APPDATA%/Jacky Image/
├── data/
│   ├── jacky-tasks.sqlite
│   └── jacky-images/
└── logs/
    ├── jacky-image.log
    └── jacky-image.previous.log
```

安装升级或重新打包不会删除这些数据。

### 开发者工具

```text
F12
Ctrl + Shift + I
View > Developer Tools (F12)
```

可查看 Console、Network、WebSocket、Sources、Local Storage、IndexedDB 和 Performance。

### 运行日志

菜单入口：

```text
Help > Open runtime log
Help > Open data folder
```

日志会收集 Electron、后端和渲染进程信息，并对常见 API Key/Authorization 内容做基础脱敏。

### 构建损坏时的恢复顺序

可以删除并重新生成：

```text
frontend/out/
build/
out/
release/
C:\Users\Public\JackyImageBuild/
```

然后重新运行：

```bash
npm run desktop:make
```

不要为了修构建问题直接删除 `%APPDATA%/Jacky Image/`，那里是真实用户数据。只有明确要重置应用数据时才删除。

---

## 9. 发布前检查清单

### 代码检查

- [ ] 确认修改的是源码目录，而不是生成目录。
- [ ] 前端依赖只改 `frontend/package*.json`。
- [ ] 后端依赖只改 `backend/package*.json`。
- [ ] Electron 工具只改根 `package*.json`。
- [ ] 没有把 API Key 写入源码、日志或打包配置。

### 构建检查

```bash
npm run build
npm run desktop:make
```

- [ ] 安装包存在。
- [ ] ZIP 存在。
- [ ] 安装包体积没有异常增长。
- [ ] 最终程序能打开页面。
- [ ] `/api/jacky/queue-status` 返回 200。
- [ ] DevTools 可以打开。
- [ ] 退出后没有残留 `Jacky Image` 或桌面后端进程。
- [ ] 日志中出现 SQLite WAL checkpoint 成功信息。

### 安全检查

```bash
npm audit --omit=dev
cd backend && npm audit --omit=dev
```

- [ ] 根生产依赖漏洞为 0。
- [ ] 后端生产依赖漏洞为 0。

### 交付提醒

当前安装包尚未代码签名，其他电脑第一次运行时可能出现 Windows SmartScreen“未知发布者”提示。正式公开发布前需要购买代码签名证书并接入签名流程。

---

## 10. 当前验证基线（2026-07-27）

已验证：

- Next.js 桌面静态构建成功。
- Electron Windows x64 package 成功。
- Squirrel Windows 安装包生成成功。
- Windows 便携 ZIP 生成成功。
- 最终桌面程序实际启动成功。
- 本地后端接口返回 200。
- Electron preload 桥接可用。
- DevTools 菜单打开成功。
- 页面初始状态无横向或纵向异常溢出。
- 应用退出后端正常结束，无残留进程。
- SQLite WAL checkpoint 成功。
- 根和后端生产依赖审计均为 0 个已知漏洞。

当前仍存在、但不是 Electron 改造引入的代码库检查问题：

- 前端 ESLint：7 个错误、10 个警告。
- 后端 ESLint：1 个未使用函数错误。
- Vitest：3 个测试失败，主要涉及 GPT Image 模型配置预期和“图像参数”控件预期。

后续如果处理这些问题，要单独修复和验证，不要为了让 CI 变绿而直接关闭对应 ESLint 规则或删除测试。

---

## 11. 2026-07-27 Electron 改造记录

### 新增

- `electron/main.cjs`
- `electron/preload.cjs`
- `forge.config.cjs`
- `scripts/generate-electron-icon.mjs`
- `scripts/prepare-electron-runtime.mjs`
- `scripts/collect-electron-artifacts.mjs`
- `scripts/launch-desktop.ps1`
- `启动 Jacky Image 开发版.cmd`
- 根目录 Electron/Forge/Playwright 开发依赖
- Windows Squirrel 和 ZIP 构建流程
- Electron 运行日志、单实例、菜单和 DevTools
- 桌面版本地数据目录
- 带随机令牌的后端安全关闭接口
- 智能检测源码变化的 Windows 双击启动器
- 预览模式和 DevTools 调试模式独立启动命令

### 调整

- `frontend/next.config.ts`：桌面构建禁用 PWA。
- `backend/server.js`：增加桌面端关闭接口。
- `backend/undici`：升级到已修复安全问题的版本。
- `.gitignore`：忽略 `release/` 等生成物。
- `README.md`：增加 Electron 使用说明。

### 已解决的坑

1. Electron 下载受网络影响：构建前复制本地 Electron ZIP 缓存。
2. `better-sqlite3` Electron ABI 重建需要 Visual Studio：改为附带匹配的 Node.js 运行时。
3. Squirrel 在中文路径调用 `rcedit` 失败：原生打包输出改到 ASCII 路径。
4. 根 `node_modules` 和旧 `out` 被误打包，安装包达到约 886 MB：Forge 明确忽略开发依赖和旧生成物。
5. 最终产物散落在临时目录：构建后统一复制到 `release/`。

---

## 12. 2026-07-27 图生图蒙版支持

### 源码

- `frontend/src/lib/mask-utils.ts`：蒙版分析、像素转换、尺寸匹配和协议策略。
- `frontend/src/components/MaskUploadControl.tsx`：专用上传、双预览、阈值、柔边和反相 UI。
- `frontend/src/components/ImageGenerationWorkbench.tsx`：当前实际使用的统一生图工作台蒙版状态。
- `frontend/src/components/ImageToImageForm.tsx`：保留兼容的旧图生图表单接入。
- `frontend/src/lib/ccode-task-client.ts`：任务 `mask` 类型。
- `frontend/src/lib/workspace-task-service.ts`：分离参考图与蒙版并创建任务。
- `frontend/src/lib/job-store.ts`：历史任务蒙版元数据。
- `backend/server.js`：蒙版验证、运行期缓存和协议转发。

### 内部统一语义

```text
白色 / 高编辑权重 = 编辑区域
黑色 / 低编辑权重 = 保留区域
```

用户上传透明 PNG 时，自动模式把透明度解释为编辑权重：透明区域编辑，不透明区域保留。亮度模式使用 Rec.709 亮度转换彩色图。

### 协议转换

- OpenAI：生成与第 1 张参考图同尺寸的 Alpha PNG，作为 multipart `mask` 字段提交；透明区域编辑。
- Google：生成黑白/灰度 PNG，作为最后一张 inline image，并在提示词中声明蒙版规则。
- Grok：生成黑白/灰度 PNG，追加到 `images`，并在提示词中声明蒙版规则。
- Google/Grok 的语义蒙版占用一个图片输入位；OpenAI 独立 `mask` 字段不占参考图位。

### 重要注意事项

- 不要使用 `prepareUploadImage` 处理原始蒙版，它可能压缩或改格式并破坏 Alpha；蒙版必须读取原始字节后在 Canvas 中转换。
- 输出蒙版必须是 `image/png`。
- OpenAI 的蒙版尺寸必须匹配第 1 张参考图；前端提交前自动缩放。
- 蒙版不能混入普通参考图数组，任务负载必须保持独立 `mask` 字段。
- 提示词优化只使用普通参考图，不把蒙版当成视觉内容。
- 当前真正使用的工作台是 `ImageGenerationWorkbench`，不要只修改旧的 `ImageToImageForm`。

### 验证基线

- 蒙版相关 Vitest：17 项通过。
- Next.js 类型检查和生产构建通过。
- Electron 实机验证通过 Alpha 检测、自动尺寸匹配、反相和亮度转换。
- UI 提交拦截验证：OpenAI 任务包含 1 张普通参考图和独立 Alpha `mask`，尺寸与第 1 张图一致。
- Gemini 模型切换后自动显示“黑白语义蒙版（自动）”。

---

## 13. 后续日志模板

后续有重要架构或构建变更时，在本文件底部追加，不要覆盖历史记录。

```markdown
## YYYY-MM-DD 变更标题

### 目的

- 为什么改

### 修改文件

- `path/to/file`

### 架构影响

- 是否影响网页版
- 是否影响 Electron
- 是否影响用户数据
- 是否影响安装包兼容性

### 验证

- [ ] build
- [ ] test
- [ ] desktop package
- [ ] desktop make
- [ ] 实际启动
- [ ] 优雅退出

### 注意事项

- 后续维护者需要知道的内容
```
