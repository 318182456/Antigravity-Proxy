# Antigravity Proxy VS Code 插件 🛰

这是一个专为 Windows 平台打造的 **Antigravity Proxy** VS Code 助手扩展，旨在帮助用户一键配置、校验、并在本地启动代理中继，实现 Antigravity 及其内部语言服务（Language Server）的透明代理，解决其在 Windows 平台下强行直连、不遵循系统代理的顽疾。

---

## 核心功能

- **🚀 一键代理启动/停止**：直接通过状态栏图标或命令面板，极速开启/关闭本地代理注入。
- **⚙️ 图形化配置面板**：提供精美的 Webview 配置页面，支持一键保存、校验，自动检测 Antigravity 安装路径。
- **📊 环境诊断与状态**：提供全方位的本地网络连通性、Hosts 解析、中继服务占用等多维度诊断结果，红绿状态一目了然。
- **🛡 极速防拦截写入**：采用内存拼接单次整体覆写的 hosts 修改机制，最大程度避免 Windows Defender / 火绒等防毒软件拦截或文件锁死报错。
- **🎯 127.0.0.2 端口避让**：内置 Node.js SNI 中继服务监听在 `127.0.0.2:443`，可与本地监听在 `127.0.0.1:443` 的 Nginx 等 Web 服务共存。

---

## 安装要求

- **操作系统**：Windows 11 / Windows 10
- **依赖服务**：本地运行的 SOCKS5 / HTTP 代理客户端（如 Clash、V2ray、Shadowsocks 等，默认监听 `10808` 或其他本地端口）
- **编辑器**：VS Code 或基于其开发的 IDE

---

## 快速使用步骤

### 1. 配置参数
* 打开本插件的 **配置页面**（可通过 VS Code 状态栏的 `AG-Proxy` 图标点按，或在命令面板中输入 `Antigravity Proxy: 打开配置页面` 进入）。
* 在页面中输入您的本地上游代理地址与端口（例如 `127.0.0.1:10808`，协议选择 SOCKS5）。
* 设置 `Antigravity IDE.exe` 或 `Antigravity.exe` 的物理路径（支持点击“自动检测”或“浏览”）。
* 点击 **💾 保存配置**。

### 2. 准备特权环境（仅需执行一次）
* 在配置页面或诊断面板中，点击 **🔧 准备特权环境**。
* 系统会弹出 UAC 管理员提权申请，请选择 **“是”**。
* 插件会极速将所需的 7 个 Google / Gemini 相关 API 域名一次性安全地写入您的系统 hosts 文件中。

### 3. 启动代理
* 在配置页点击 **🚀 启动代理**，或者点击 VS Code 状态栏上的红灯/黄灯图标。
* 状态栏图标变为**绿色**（`AG-Proxy: ok`），说明本地 `127.0.0.2:443` 的 SNI 中继以及子进程注入已全部完美就绪。
* 现在，您的 Antigravity 可以流畅地在代理网络下工作了。

---

## 常见排查与诊断

本插件内置了强大的 **环境诊断与状态** 页面，为您提供以下 9 大维度的健康检查：
1. **上游代理 (TCP 连通)**：确认本地代理软件的端口是否存活。
2. **上游代理 (SOCKS5 握手)**：确认代理协议握手是否成功。
3. **Antigravity.app 路径**：验证主程序是否存在。
4. **Hosts 劫持域名检测**：检测 7 个域名是否成功重定向至 `127.0.0.2`。
5. **SNI 中继（本机 :443）**：确认本地 `127.0.0.2:443` 端口中继是否成功监听且运行正常。
6. **系统网络代理（Windows 全局）**：检查系统代理配置是否产生干扰。

### 常见报错解决方法：

#### 1. 启动失败，提示 443 端口被 Nginx 占用？
* **原因**：Nginx 默认配置了通配监听 `listen 443 ssl;`（等同于监听 `0.0.0.0:443`），霸占了整台电脑所有 IP 的 443 端口，导致本工具无法绑定 `127.0.0.2:443`。
* **解决办法**：修改您的 `nginx.conf` 配置文件，限制 Nginx 监听的 IP 范围。例如：
  ```nginx
  listen 127.0.0.1:443 ssl;
  listen 172.28.26.111:443 ssl; # 您的局域网IP
  ```
  或者直接将 Nginx 本地开发端口修改为 `8443`（`listen 8443 ssl;`），把 443 端口腾出来。修改后重启 Nginx 即可完美共存。

#### 2. Hosts 写入失败或显示为红叉？
* **解决方法**：这通常是因为安全软件拦截或 UAC 弹窗被取消。您可以以管理员身份运行记事本，手动打开 `C:\Windows\System32\drivers\etc\hosts` 文件，并在最末尾追加以下内容并保存：
  ```text
  # antigravity-proxy
  127.0.0.2 daily-cloudcode-pa.googleapis.com # antigravity-proxy
  127.0.0.2 cloudcode-pa.googleapis.com # antigravity-proxy
  127.0.0.2 oauth2.googleapis.com # antigravity-proxy
  127.0.0.2 accounts.google.com # antigravity-proxy
  127.0.0.2 www.googleapis.com # antigravity-proxy
  127.0.0.2 generativelanguage.googleapis.com # antigravity-proxy
  127.0.0.2 content-cloudcode-pa.googleapis.com # antigravity-proxy
  ```

---

## 插件内置命令列表

- `antigravity-proxy.start`：🚀 启动代理
- `antigravity-proxy.stop`：⏹ 停止代理
- `antigravity-proxy.openSettings`：⚙️ 打开配置页面
- `antigravity-proxy.openDiagnostics`：📊 环境诊断与状态
- `antigravity-proxy.testUpstreamProxy`：🔌 检测上游代理（TCP + SOCKS5）
- `antigravity-proxy.prepareEnvironment`：🔧 准备特权环境（写入 hosts 并启动中继）
- `antigravity-proxy.cleanupEnvironment`：🧹 清理 hosts 与中继
- `antigravity-proxy.restoreNoProxy`：🔕 完全停用代理（恢复 hosts/中继）

---

## 许可证

MIT License
