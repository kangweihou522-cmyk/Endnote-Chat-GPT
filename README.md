# EndNote ChatGPT

检查并补全 EndNote 期刊论文的书目信息。支持联网核对期刊全称、原文标题、作者全名、卷、期、页码或文章编号、出版日期、网络发表日期、DOI、ISSN、年份和 Translated Title。

## 当前状态

已实现补全引擎、ChatGPT 订阅授权和 EndNote XML 验证界面。你可以用这个界面检验字段和来源。**EndNote 文献列表内的右键命令和原条目写回仍待接入。**

Clarivate 的公开示例说明了如何在 `Tools` 菜单安装原生插件。文献列表右键菜单需要通过相应 EndNote 版本的 EDK/RDK 核查，选中条目的读取及改动的原位保存也需要在 Windows EndNote 上验证。获取开发包需要填写 Clarivate 表单并接受其条款。 [开发包申请](https://discover.clarivate.com/wos_endnote-development-kit) · [Clarivate 插件文档](https://docs.endnote.com/docs/endnote/2025/v1/windows/en/content/appendices/apis_and_plug-ins.htm)

## 用 XML 验证

1. 安装 Node.js 22.12 或更高版本，将仓库下载或克隆到本机。在仓库目录运行以下命令。

   ```sh
   npm ci
   npm start
   ```

2. 在 EndNote 选中一些 `Journal Article` 条目。使用 **File → Export**，文件类型选 **XML**，勾选 **Export Selected References**。仓库里的 `tests/fixtures/dreadds.xml` 也可以用来验证。 [EndNote 导出说明](https://docs.endnote.com/docs/endnote/2025/windows/v1/content/15independentbibs_export/exporting_to_endnote_xml.htm)
3. 在工具中点 **打开 EndNote XML**。如需补译名，先点 **连接 ChatGPT → Continue with ChatGPT**，在默认浏览器完成官方登录和授权，返回工具选择账户模型和译名语言。默认译为简体中文，也可选英语。
4. 点 **一键检查补全**。每个条目可以核对原值、建议值、来源及冲突。高置信度的补全项会勾选，有冲突的内容留待确认。未匹配条目可能显示候选，也可以主动请 ChatGPT 辅助核对。
5. 点 **导出已选修改** 生成另一个 XML，其中包含已勾选修改的条目。用 **File → Import → File → EndNote Generated XML** 导入测试库。EndNote 的 XML 导入会创建记录。已在 Word 里引用的条目请按建议修改原记录，保留现有引用关系。 [EndNote 导入选项](https://docs.endnote.com/docs/endnote/2025/v1/windows/en/content/08import/import_options.htm)

## 书目核对和 ChatGPT

- **Crossref、PubMed** 提供书目信息。有 DOI 或 PMID 优先用标识符检索，再核对题名、作者、年份等。缺少标识符时用已有文献字段搜索。不同来源有明显冲突时需确认。来源只给作者首字母或没有期号、日期时，界面显示实际可查到的信息。
- **ChatGPT** 通过与 [Zotero ChatGPT PDF](https://github.com/kangweihou522-cmyk/zotero-chatgpt) 同样的官方 Sign in with ChatGPT 授权使用账户可用的订阅额度。连接后用于生成题名译文和辅助核对候选。期刊全称、作者、年份、ISSN 和 DOI 等事实字段来自文献数据库。引用检索可独立运行。生成译名时提交题名，核对候选时提交相关书目字段。PDF、附件和笔记留在本机。 [OpenAI 授权说明](https://developers.openai.com/siwc/token-sharing-open-source) · [ChatGPT 用量](https://chatgpt.com/settings/usage)
- 令牌保存在应用的系统加密存储中。使用资格、模型、额度和应用权限由 ChatGPT 账户决定。整个授权流程通过个人 ChatGPT 登录完成，无需 API Key。

## 验证与构建

```sh
npm test
npm run package:win
```

测试使用公开书目信息构造检索响应，并模拟 OpenAI 授权及流式推理。Windows 打包输出目录为 `dist/EndNote-ChatGPT-win32-x64/`。项目沿用 Zotero ChatGPT PDF 的 AGPL-3.0 许可。OAuth 模块保留原 MIT 许可和来源说明。
