# MessageHook · Webhook 消息推送（Chrome / Edge 扩展）

把浏览器里看到的内容，一键通过 Webhook 推到手机：企业微信、钉钉、飞书、Bark、Server 酱、ntfy、Telegram、Slack、Discord，或你自己写的任意 HTTP 接口。

- **地址簿**：多个 Webhook 地址，每个有名称、地址、请求方法、Content-Type、自定义请求头、消息模板（正文用 `{{ content }}` 占位），支持导入 / 导出。
- **发送**：选地址 → 写内容（Markdown / 纯文本 / HTML）→ 发送；可预览最终请求，右侧菜单也能直接推送选中文字。
- **零依赖**：纯原生 JS，没有构建步骤，加载即用。

---

## 一、安装

1. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）。
2. 右上角打开 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择本项目的 `extension` 目录。
4. 首次安装会自动打开「地址簿」页面，先把你的 Webhook 配好。

工具栏图标可固定在浏览器右上角；默认快捷键 **Alt + Shift + S** 打开推送面板（可在 `chrome://extensions/shortcuts` 修改）。

## 二、快速上手（3 步）

1. **加地址**：地址簿页 →「＋ 新增地址」，或在工具栏的「从预设模板开始…」里选一个（企业微信 / Bark / Server 酱…），把里面的 `YOUR_KEY` 换成自己的。
2. **写模板**：确认「消息模板」里的 `{{ content }}` 位置正确，右侧「请求预览」会实时显示真正发出的 URL、请求头和请求体。
3. **发消息**：点工具栏图标 → 选地址 → 输入内容 → **发送**（`Ctrl + Enter` 也能发）。发送结果、HTTP 状态码和响应内容会直接显示出来。

## 三、地址簿

每条地址包含这些字段：

| 字段 | 说明 |
| --- | --- |
| 名称 | 显示在推送面板与右键菜单里 |
| Webhook 地址 | `http://` 或 `https://` 开头，**地址本身也支持变量**（如 `https://api.example.com/{{ title }}`） |
| 请求方法 | `POST`（默认）/ `PUT` / `PATCH` / `GET` / `DELETE`。`GET` 没有请求体，模板渲染结果会拼到查询串上 |
| Content-Type | 决定 `{{ content }}` 的转义方式：`application/json` → JSON 转义；`application/x-www-form-urlencoded` → URL 编码；其他（含 `text/plain`）→ 原样输出 |
| 自定义请求头 | 每行一个 `名称: 值`，值里同样能用变量，例如 `Authorization: Bearer YOUR_TOKEN`、`X-Title: {{ title }}`（见下方「请求头注意事项」） |
| 消息模板 | 真正发出去的请求体，正文用 `{{ content }}` 占位 |
| 启用 | 停用后不出现在推送面板和右键菜单里，但配置保留 |
| Markdown→HTML | 勾选后，发送前先把 Markdown 正文渲染成 HTML 再注入 `{{ content }}` |

### 模板变量

| 变量 | 含义 |
| --- | --- |
| `{{ content }}` | 消息正文（按 Content-Type 自动转义） |
| `{{ title }}` | 标题：手动填写，留空则用页面标题 |
| `{{ url }}` | 来源页面地址 |
| `{{ format }}` | 内容格式：`markdown` / `text` / `html` |
| `{{ time }}` `{{ date }}` `{{ datetime }}` `{{ timestamp }}` | 时间、日期、日期时间、Unix 毫秒时间戳 |
| `{{ webhook_name }}` | 当前地址的名称 |
| `{{ hostname }}` | 来源页面的域名 |

写法很宽松：`{{content}}`、`{{ content }}` 都可以。任何变量都能加后缀**强制指定转义方式**：

- `{{ content_json }}` → JSON 字符串转义（不含首尾引号，可直接放进 JSON 的引号里）
- `{{ content_url }}` → `encodeURIComponent`
- `{{ content_raw }}` → 原样输出

模板里出现未知变量时会替换成空串，并在预览区给出提示，避免把 `{{ xxx }}` 原样发出去。

### 请求头注意事项

HTTP 头部的值只允许 ≤ 0xFF 的字符，中文这类字符会让浏览器直接抛 `TypeError`。因此请求头里如果渲染出了非 ASCII 字符，扩展会自动按 **RFC 2047**（`=?UTF-8?B?...?=`）编码后再发送，并在预览里提示；如果对方服务不认这种编码，请把该字段放进请求体（例如 ntfy 的 JSON 发布接口就是这么做的），或改用 `{{ xxx_url }}`。

### 导入 / 导出

- **导出**：导出为 JSON 文件，或直接复制到剪贴板。
- **导入**：从文件导入，或粘贴 JSON 后导入；可选「合并 / 覆盖」，重名时可「保留两者（自动改名）/ 覆盖 / 跳过」。

导出格式如下，字段都有默认值，所以手写一个更简单的文件也能导入：

```json
{
  "format": "messagehook-addressbook",
  "version": 1,
  "webhooks": [
    {
      "name": "我的手机",
      "url": "https://api.day.app/push",
      "method": "POST",
      "contentType": "application/json",
      "headers": "",
      "template": "{\"device_key\":\"YOUR_KEY\",\"title\":\"{{ title }}\",\"body\":\"{{ content }}\"}",
      "mdToHtml": false,
      "enabled": true
    }
  ]
}
```

也兼容更宽松的写法：直接给数组 `[{ "name": "...", "url": "..." }]`、单个对象 `{ "url": "..." }`，字段名支持 `label` / `webhook` / `endpoint` / `body` 等别名，JSON 里带 `//` 或 `/* */` 注释也能解析。

## 四、内置预设

通用 JSON / 通用表单 / 通用纯文本 / 通用 HTML、企业微信（文本 / Markdown）、钉钉 Markdown、飞书（文本 / 富文本）、Server 酱³、PushPlus、Bark、ntfy、Gotify、Telegram Bot、Slack、Discord。

选预设只会填充表单，**不会立刻保存**，改完记得点「保存」。

## 五、右键菜单

在页面或选中文字上点右键 → **MessageHook 推送到手机** → 选一个地址：

- 选中了文字 → 推送选中的文字；
- 右键在链接上 → 推送链接地址；
- 其他情况 → 推送当前页面地址。

列表实时跟随地址簿变化，停用的地址不会出现。

## 六、权限说明

| 权限 | 为什么需要 |
| --- | --- |
| `storage` | 保存地址簿、设置和最近发送记录（全部存在本地，不上传任何服务器） |
| `contextMenus` | 右键菜单推送 |
| `host_permissions: http(s)://*/*` | 后台 Service Worker 需要绕过页面 CORS 才能把请求发到你自己的 Webhook 域名 |

> 只想给自己的几个域名授权的话，把 `extension/manifest.json` 里的 `host_permissions` 改成具体域名即可，例如：
> ```json
> "host_permissions": ["https://qyapi.weixin.qq.com/*", "https://api.day.app/*"]
> ```
> 改完在 `chrome://extensions/` 里点一下「重新加载」。注意：没有授权的域名，请求会被浏览器按普通 CORS 处理，多数 Webhook 会失败。

数据全部保存在浏览器本地（`chrome.storage.local`），扩展不会向任何第三方服务器发送数据；所有请求都只发往你自己配置的地址。

## 七、开发与测试

```bash
node test/run.mjs           # 单元测试：模板转义、请求构造、Markdown 渲染、导入导出、预设、清单一致性
node test/integration.mjs   # 集成测试：起本地 HTTP 服务，验证 JSON/表单/GET/请求头/超时/错误码
node test/ui-smoke.mjs      # 冒烟测试：用 DOM 桩跑真实的 popup.js / manage.js / background.js
npm run test:all            # 三个一起跑
```

`test/ui-smoke.mjs` 会真的执行三个页面脚本（配合 `chrome.*` 与 DOM 桩），验证「点发送 → 后台 → 真实 HTTP 请求」的完整链路，以及新增 / 保存 / 测试 / 导入 / 导出 / 删除、右键菜单推送等交互。仅需 Node 18+，无第三方依赖。

目录结构：

```
extension/
  manifest.json      # MV3 清单
  background.js      # Service Worker：统一发送、右键菜单、发送记录、角标反馈
  popup.html/.js     # 推送面板
  manage.html/.js    # 地址簿管理页
  ui.css             # 两个页面共用的样式
  lib/
    template.js      # 模板变量与转义
    request.js       # 请求构造 + 发送（预览与实际发送共用同一份逻辑）
    markdown.js      # 极简 Markdown → HTML
    storage.js       # 数据层：地址簿 / 设置 / 记录 / 导入导出
    presets.js       # 内置预设模板
    ui.js            # DOM 小工具（元素构造、toast、下载、剪贴板）
tools/make_icons.py  # 重新生成图标
test/                # 测试
```

## 八、已知限制

- **Markdown 渲染是简版**：支持标题、段落、行内样式、行内/围栏代码、有序无序列表（含嵌套）、引用、分割线、链接、图片、简单表格，不做完整 CommonMark。
- **Markdown→HTML 只影响 `{{ content }}`**：整条消息的格式仍由模板决定。
- **GET 请求**不能带请求体，模板结果会拼进查询串。
- **响应只读前 4000 字符**用于展示，不影响发送。
- 请求超时默认 20 秒。
