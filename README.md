# EndNote ChatGPT

Windows 文献工作站。输入期刊论文标题或 DOI，核对原始书目信息，生成可导入 EndNote 的 RIS，并查找 PDF 和全文入口。

## 使用

1. 下载 Windows x64 压缩包，解压整个文件夹，打开 **EndNote-ChatGPT.exe**。 [下载 Windows 版](https://github.com/kangweihou522-cmyk/Endnote-Chat-GPT/releases/latest)
2. 如需自动译名，点 **连接 ChatGPT → Continue with ChatGPT**。在默认浏览器完成官方授权，返回软件选择账户模型。使用有资格的 ChatGPT 订阅额度，无需 API Key。 [OpenAI 授权说明](https://developers.openai.com/siwc/token-sharing-open-source) · [ChatGPT 用量](https://chatgpt.com/settings/usage)
3. 在 **标题转 RIS** 页粘贴论文标题或 DOI，点击 **查找论文**。匹配有歧义时，可以选择正确的论文，也可请 ChatGPT 辅助比较候选。默认译名语言为简体中文，可改为英语。
4. 点击 **保存 RIS**。在 EndNote 选择 **File → Import → File**，选择该文件，**Import Option** 选 **RefMan RIS**。中文字符显示异常时，可将 **Text Translation** 设为 UTF-8 再导入。 [Clarivate RefMan RIS 过滤器](https://endnote.com/downloads/filters/refman-ris/)
5. 在 **PDF 与全文** 区打开或复制链接。资料库收录免费的 PDF 直链时优先显示。出版社登记的 PDF 可能需要个人或机构订阅。检测到 PubMed Central 全文时会提供对应文章页。

## ChatGPT 连接状态

浏览器显示「授权结果已送回软件」后，切回 EndNote ChatGPT，等软件显示可选模型。授权请求使用系统网络设置。

- 显示「ChatGPT 已授权 · 模型待连接」时，可以点「刷新模型」重试读取。
- 若出现错误，连接面板会显示失败步骤，以及服务提供的 HTTP 状态、错误代码和请求编号。反馈问题时可直接复制面板里的诊断文字。浏览器回调地址包含一次性授权码，回传成功后页面会清除地址栏中的参数。

## 字段与来源

- Crossref 和 PubMed 提供原文题名、作者、期刊全称、卷期、页码或文章编号、年份、日期、DOI 和 ISSN。未收录的字段留空，有冲突的字段待手动确认。作者全名取决于来源提供的姓名信息。
- RIS 以 UTF-8 保存，题名译文写入 TT，网络发表日期写入备注。EndNote 字段映射由当前导入过滤器决定。
- PDF 来源是 Europe PMC 收录的地址或 Crossref 登记的 PDF 链接。缺少 PDF 时，仍显示可查到的全文页、出版社页面或 PubMed 记录。 [Europe PMC API](https://europepmc.org/RestfulWebService) · [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)
- ChatGPT 用于题名翻译和候选核对。译名请求只提交题名，核对候选请求提交相关书目字段。授权令牌由本地系统加密存储。

## 批量检查 XML

**批量检查 XML** 页可以打开 EndNote 导出的期刊论文 XML、检查字段并导出勾选的修改。XML 导入会在 EndNote 中创建记录。已在 Word 里引用的文献可以按建议修改原条目，保留现有引用关系。 [EndNote 导出 XML 说明](https://docs.endnote.com/docs/endnote/2025/windows/v1/content/15independentbibs_export/exporting_to_endnote_xml.htm)

## 开发与构建

需要 Node.js 22.12 或更新版本。

```sh
npm ci
npm test
npm start
npm run package:win
```

Windows 打包目录为 dist/EndNote-ChatGPT-win32-x64/。测试使用模拟文献 API 和授权响应。项目沿用 Zotero ChatGPT PDF 的 AGPL-3.0 许可，OAuth 模块保留原 MIT 许可与来源说明。
