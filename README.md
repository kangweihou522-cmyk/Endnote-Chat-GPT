# EndNote ChatGPT

Windows 文献工作站。按标题或 DOI 查询期刊论文、生成 RIS、查找 PDF；也可以把已有 RIS 批量转换成投稿期刊所需的字段和参考文献格式。

## 安装和连接

1. 下载 Windows x64 压缩包，解压整个文件夹，打开 **EndNote-ChatGPT.exe**。更新版本时先退出旧版。 [下载 Windows 版](https://github.com/kangweihou522-cmyk/Endnote-Chat-GPT/releases/latest)
2. 如需 ChatGPT 译名、模板指南或对话，点 **连接 ChatGPT → Continue with ChatGPT**。浏览器回传后切回软件并选择可用模型。使用有资格的 ChatGPT 订阅额度，无需 API Key。 [OpenAI 授权说明](https://developers.openai.com/siwc/token-sharing-open-source) · [ChatGPT 用量](https://chatgpt.com/settings/usage)
3. 显示「已授权 · 模型待连接」时，可以点 **刷新模型**。其他连接问题可反馈软件里的诊断文字。

## 标题转 RIS

输入标题或 DOI。核实候选后，可看期刊全称和缩写、原文题名、作者、卷期页、印刷及电子 ISSN、出版日期、DOI、PMID、PMCID。展开 **扩展题录** 查看来源提供的摘要、关键词、MeSH、作者单位、ORCID 等。ChatGPT 可以生成译名并标注来源。PDF 与全文区提供可查到的链接。 [PubMed 题录字段](https://pubmed.ncbi.nlm.nih.gov/help/) · [Europe PMC API](https://europepmc.org/RestfulWebService)

点 **保存完整 RIS** 保存原始题录。选择目标期刊后，可以预览并复制排版引文，或独立保存 **期刊版 RIS**。RIS 以 UTF-8 保存。跨导入过滤器兼容性较低的字段保存在备注里，例如 PMCID、网络发表日期和 ORCID。EndNote 里用 **File → Import → File → RefMan RIS** 导入。 [Clarivate RefMan RIS](https://endnote.com/downloads/filters/refman-ris/)

## 批量转换格式

1. 打开一份或多份 RIS，或导入本次刚保存的 RIS。旧中文文件无法自动解码时可选择 **GB18030** 重新打开。
2. 选择目标期刊或模板，并确认勾选范围。可在 **本批规则** 里调整期刊全称或缩写、大小写、DOI 字段和排序。预览显示实际改动与缺少的资料。需要核对缺失字段时，勾选 **先联网补全**。
3. 点 **转换并导出 RIS** 另存一个新文件。**导出引文 TXT** 生成排版文本，**复制排版引文** 支持粘贴至 Word。引文中的缩写和省略作者规则只影响排版；RIS 保留真实的作者名单和顺序。Word 中的动态参考文献排版由 EndNote 的输出样式决定。 [EndNote 输出样式](https://docs.endnote.com/docs/endnote/2025/windows/v1/content/18styles/the_output_styles_menu.htm)

可展开右侧 **AI 对话**，例如输入「这一批按浙大示例，期刊写全称，题名冒号后大写，保留 DOI，按原文件顺序导出 RIS」。模型会将要求应用到预览。明确要求导出时，软件会打开保存窗口。临时规则也可以另存为本机模板。

### 添加模板

**添加模板** 可以搜索本地 CSL 索引，下载匹配的期刊样式。也可以提供公开网页链接或粘贴作者指南的参考文献部分，让 ChatGPT 提取规则，核对示例后保存。遇到 PDF 指南，可复制相关段落粘贴到页面内。Nature 和 Nature Methods 可打开已核实的 EndNote 样式页面。内置的浙大模板按期刊全称和冒号后首词大写的示例设置，具体学院要求请用指南核对。 [CSL 样式库](https://github.com/citation-style-language/styles) · [EndNote 样式库](https://endnote.com/downloads/styles/)

## 批量检查 XML

**批量检查 XML** 可以打开 EndNote 导出的期刊论文 XML、检查并导出勾选的改动。导入 XML 时 EndNote 会创建记录。已在 Word 引用的条目可以按建议更新原条目。 [EndNote XML 导出](https://docs.endnote.com/docs/endnote/2025/windows/v1/content/15independentbibs_export/exporting_to_endnote_xml.htm)

## 开发与构建

需要 Node.js 22.12 或更新版本。

```sh
npm ci
npm test
npm start
npm run package:win
```

Windows 打包目录为 dist/EndNote-ChatGPT-win32-x64/。项目采用 AGPL-3.0，OAuth 模块保留原 MIT 许可。 [CSL 资源署名](src/styles/NOTICE.md)
