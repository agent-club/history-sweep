# History Sweep: choosing a history tool by task

**English** · [简体中文](#简体中文)

This note records a small hands-on comparison, with a fresh check of the History Sweep repository build and a limited competitor UI recheck. It is intended to help people choose a workflow, rather than rank every feature of each product.

## Builds and scope

- **History Sweep:** repository version **0.3.2**, source commit [`7a174e13ea0c54cf926f178cf7b780419a140ea7`](https://github.com/agent-club/history-sweep/commit/7a174e13ea0c54cf926f178cf7b780419a140ea7). The extension was loaded from `extension/`. The checked-in 0.3.2 download contains the same extension file contents.
- **Earlier comparison, October 1, 2026 UTC:** History Sweep 0.3.1, Better History 7.0.0, History Cleaner Pro by HVS 1.1, and History Cleaner by Tags 3.2.0, using Google Chrome 154.0.8037.92 on Linux. Better History's tested extension ID was `egehpkpgpgooebopjihjmnpejnjafefi`.
- **Limited competitor recheck, October 2, 2026 UTC:** Better History 7.0.0, HVS 1.1, and Tags 3.2.0 were freshly installed from their official Chrome Web Store listings in the same signed-out disposable profile as the 0.3.2 replay. This covered controls and partial flows; no competitor deletion was executed.
- Tests use isolated browser profiles and disposable test history. No personal browsing history is needed for the procedure below.
- The repository build and the Chrome Web Store release are separate. The repository's submission record, dated October 1, says 0.3.1 was published and 0.3.2 was saved as a draft. This is a dated record, not a live store-status guarantee. Check the version installed in your browser.

## Which task are you trying to do?

| Tool and tested version | Observed workflow |
| --- | --- |
| History Sweep 0.3.2 repository build | Website/text matching, a reviewed selection, kept-site rules, and deletion-result checking. Its focus is a deliberate cleanup of selected URLs. |
| Better History 7.0.0 | A broader full-page history-browsing workspace with date/hour navigation and export controls. The presence of a control is not an end-to-end test of export or scheduling. |
| History Cleaner Pro by HVS 1.1 | A compact popup for keyword search, selection, and deletion confirmation. The October 2 recheck cancelled at the confirmation. |
| History Cleaner by Tags 3.2.0 | Tag/rule and automatic-cleanup settings. Scheduled, startup, and browsing-triggered cleanup were not evaluated. |

These are observed workflows in the tested interfaces, not an exhaustive feature inventory. A feature not mentioned here may exist in another view or version. No claim is made that one product is universally faster, safer, or better.

## A reproducible small task

Use a disposable profile with history sync off. The following is a full replay recipe, not a claim that every extension completed these steps on October 2. The limited competitor recheck described below used the surviving records and did not execute deletion. For a full comparison, visit these five test URLs, rebuilding the same fixture before testing another extension:

```text
https://example.com/?nyxtest=remove-one
https://example.com/?nyxtest=remove-two
https://example.com/?nyxtest=keep-this
https://example.org/?nyxtest=other-domain
https://example.com/?query=example.org
```

1. Search for `example.org`. In History Sweep, compare **Smart match** with **Title or URL**. The last URL mentions the text in a query string but belongs to `example.com`.
2. Search for `nyxtest` using **Title or URL**. It is a test marker, not a website name. Review the four matching URLs.
3. Select the results, then leave `keep-this` unselected. Review the three selected URLs in the confirmation.
4. Cancel once and confirm that no test URLs were removed. Repeat, confirm deletion, and search again to check both the selected URLs and the unselected exception.
5. For 0.3.2, separately test date filters and kept websites, and restore any kept-site rule before the next scenario.

For domain-only input, Smart match includes that domain and its subdomains. **Exact domain** selects one hostname. **Title or URL** intentionally searches the text, including query strings. These modes express different requests; matching extra text in a text-search mode is not itself a defect.

## Evidence from the earlier comparison

On October 1, History Sweep 0.3.1 returned one URL for Smart match `example.org` and two for Title or URL. The selected-deletion task removed three of the four `nyxtest` URLs, retained `keep-this`, and displayed its verification result. HVS and Better History also completed the selected-deletion task in their tested flows. This small test does not establish behavior under large or interrupted workloads.

## Fresh repository-build replay — October 2, 2026 UTC

Version 0.3.2 was loaded as an unpacked extension through Chrome's extension UI in a fresh isolated profile, using official Google Chrome 154.0.8037.92 (x86_64 Linux). The prior comparison profile was left unchanged. The test date is October 2 UTC; the browser's local date display was still October 1.

- **Website versus text:** Smart match for `example.org` returned the one real `example.org` record. Title or URL returned two records, including `example.com/?query=example.org`.
- **Current website:** Find this website chose Exact domain and returned the four `example.com` fixture URLs. The action searched without deleting them.
- **Grouping:** The full-page workspace showed the matching records grouped by website, with select-all available.
- **Review and cancel:** Title or URL for `nyxtest` found four URLs. After selecting all and excluding `keep-this`, the confirmation showed three URLs across two websites, together with the all-visits, irreversible-deletion, and sync warnings. Cancelling and searching again left all four test URLs present.
- **Selected deletion:** Repeating the selection and confirming removed three URLs. The app reported that none of the selected URLs remained. A fresh search returned exactly the unselected `keep-this` URL; Chrome's own history search independently showed one `nyxtest` result.
- **Date-only search:** Choosing Today with an empty keyword returned history from the local test profile, including extension pages and a local fixture file. The raw count was not a web-fixture count. This did not test visits across date boundaries or repeated visits to the same URL.
- **Kept website:** Adding `example.com` to kept websites excluded the two remaining URLs on that domain from the displayed results and showed a notice that two matching URLs were kept. Live subdomain protection was not part of this small replay; hostname-boundary and subdomain rules are covered separately by the repository unit tests.
- **View changes:** The popup's current-site search showed the same two surviving `example.com` URLs. Choosing Open full page with a selection displayed a warning that a new search would start and the selection would not transfer; this navigation was cancelled. The views should not be described as sharing a synchronized selection. The test kept-site rule was removed afterward.

## Limited competitor UI recheck — October 2, 2026 UTC

The versions were verified in Chrome's extension manager: Better History **7.0.0** (`egehpkpgpgooebopjihjmnpejnjafefi`), History Cleaner Pro by HVS **1.1** (`anljiajpccjocbhocgalcgoafnnkfdpl`), and History Cleaner by Tags **3.2.0** (`ckjjcldcdgcleaiidahlffloopnmjloa`). Only History Sweep executed deletion during this fresh session.

- **Better History:** The workspace showed day/hour navigation, CSV/HTML export, Delete Entire Date, Blacklist Domain, Smart Auto Cleanup, and Advanced Export controls. Searching `example.org` returned the surviving `example.com/?query=example.org` URL. This is consistent with title-or-URL text search, not a defect. Deletion, export, blacklist execution, and automatic cleanup were not exercised.
- **HVS:** Searching `example` returned the two surviving fixture URLs. Select All followed by excluding `keep-this` left one selected. Delete Selected opened a confirmation for one history item; it was cancelled. This verifies search, selection, and confirmation, not a fresh deletion result.
- **Tags:** The Clean panel showed saved tag chips and Clean now. Schedule showed Clean automatically, Clean on browser start, Match URL only, and Clean while browsing. The three automation toggles were off, Match URL only was on, and Next run displayed Not scheduled. Options showed settings sync and backup controls. No rule was changed, no schedule enabled, and no cleaning executed. No dry-run behavior was observed.

## Repository checks

On October 2, 2026 UTC, all **52 unit tests** passed on the 0.3.2 source commit above. Packaging validated store-asset dimensions and generated the extension and static-site ZIP files. These checks are separate from browser interaction: synthetic tests do not establish real Chrome throughput or cross-device behavior.

## Boundaries that matter

- Deleting a URL removes **all visits to that URL** and cannot be undone. Date filters choose URLs by their **last visit**; they do not restrict deletion to individual visits within the chosen dates.
- Chrome may sync history deletions across signed-in devices. Sync propagation was not tested.
- History Sweep reads up to 100,000 URLs per search. A passing synthetic test is not a real-history performance benchmark at that size.
- Website navigation, export controls, and automatic-cleanup settings were inspected, but this comparison does not establish scheduled execution, export completeness, accessibility compliance, privacy/network behavior, or security.
- A result in one browser/OS combination is not a guarantee for other profiles, devices, or releases. The public comparison intentionally avoids turning one-session anomalies into general claims about competitors.

## 简体中文

这是一份按任务选择工具的小样本实测记录，同时对 History Sweep 仓库版本和部分竞品界面进行复查。它帮助读者理解不同操作流程，不对产品全部功能做排名。

### 版本与范围

- History Sweep 使用 **0.3.2 仓库版本**，源码提交为 [`7a174e13ea0c54cf926f178cf7b780419a140ea7`](https://github.com/agent-club/history-sweep/commit/7a174e13ea0c54cf926f178cf7b780419a140ea7)，从 `extension/` 加载。仓库内 0.3.2 下载包的插件文件内容与该源码一致。
- 前一轮对比发生在 **2026 年 10 月 1 日 UTC**，环境为 Linux / Google Chrome 154.0.8037.92，版本为 History Sweep 0.3.1、Better History 7.0.0、History Cleaner Pro by HVS 1.1、History Cleaner by Tags 3.2.0。被测 Better History 的扩展 ID 是 `egehpkpgpgooebopjihjmnpejnjafefi`。
- **2026 年 10 月 2 日 UTC 的有限竞品复查：** 在 0.3.2 复测使用的同一个未登录临时配置中，从官方 Chrome 应用商店重新安装 Better History 7.0.0、HVS 1.1 和 Tags 3.2.0，只检查控件和部分流程，未执行竞品删除。
- 使用隔离浏览器配置和可删除的测试记录，无需真实个人历史。
- 仓库版本不等于应用商店当前发布版本。仓库中 10 月 1 日的提交记录写明：0.3.1 已发布，0.3.2 保存为草稿。这是有日期的记录，不代表实时商店状态；请以浏览器已安装版本为准。

### 按任务选择

- **History Sweep 0.3.2：** 按网站或文字查找、核对选择、保留网站规则，以及删除结果复查，聚焦于主动清理选中的网址。
- **Better History 7.0.0：** 更广的完整历史浏览工作台，可见日期、小时导航和导出入口。看到入口不等于完成导出或定时执行测试。
- **History Cleaner Pro by HVS 1.1：** 紧凑小窗里的关键词搜索、结果选择及删除确认；10 月 2 日复查在确认窗口取消。
- **History Cleaner by Tags 3.2.0：** 标签、规则和自动清理设置。本轮未验证定时、启动时或浏览时触发的清理。

这些是被测界面中观察到的流程，不是完整功能清单。未提及的功能可能存在于其他视图或版本；不据此宣称任何产品普遍更快、更安全或更好。

### 如何复测

以下是完整复测方法，不代表每个插件都在 10 月 2 日完成了这些步骤。下方记录的有限竞品复查使用剩余记录，未执行删除。如需完整比较，请在关闭历史同步的临时浏览器配置中，访问上方英文部分列出的五个测试网址；每换一个插件，重新建立相同记录。

1. 搜索 `example.org`，在 History Sweep 中对比**智能匹配**与**标题或网址**。最后一个网址只在参数中提到这段文字，实际属于 `example.com`。
2. 用**标题或网址**模式搜索 `nyxtest`，查看四条记录。它是测试标记，不是网站名称。
3. 选中结果，取消 `keep-this`，在确认窗口核对其余三个网址。
4. 先取消一次，确认测试记录未被删除。重复选择并确认删除，然后重新搜索，检查删除项和保留项。
5. 对 0.3.2 单独测试日期筛选及保留网站，下一场景开始前还原保留规则。

智能匹配完整域名时包含该域名及其子域名；**精确域名**用于单一主机名；**标题或网址**有意搜索文字，也会命中查询参数。三种方式表达不同请求，文字模式命中额外文字本身不是缺陷。

### 前一轮证据与仓库检查

10 月 1 日，History Sweep 0.3.1 用智能匹配搜索 `example.org` 得到一条，用标题或网址得到两条；四条 `nyxtest` 中删除三条、保留 `keep-this`，并显示核验结果。HVS 和 Better History 也在各自被测流程中完成了所选记录删除。这不能证明大规模或中断场景下的表现。

2026 年 10 月 2 日 UTC，在全新的隔离 Chrome 配置中，通过扩展程序界面加载 0.3.2 仓库版本，使用官方 Google Chrome 154.0.8037.92（x86_64 Linux），前一轮配置保持不变。测试时浏览器本地日期仍显示 10 月 1 日。复测确认：

- **网站与文字：** 智能匹配 `example.org` 得到一条真实域名记录；标题或网址得到两条，包含 `example.com/?query=example.org`。
- **当前网站：** 当前网站入口使用精确域名，找到四条 `example.com` 测试记录；只执行搜索，没有自动删除。
- **分组：** 完整页面按网站显示匹配记录，并提供全选入口。
- **核对与取消：** 标题或网址搜索 `nyxtest` 找到四条。全选并取消 `keep-this` 后，确认窗口列出两个网站下的三个网址，提示全部访问、无法撤销和同步影响。取消并重新搜索，四条测试网址都仍存在。
- **所选删除：** 再次选择并确认后删除三条；插件报告所选网址均已移除。重新搜索，仅剩未选中的 `keep-this`；Chrome 自身的历史搜索也独立显示一条 `nyxtest` 结果。
- **只按日期搜索：** 留空关键词、选择今天，可以查到本地测试配置中的记录，包含插件页面和本地测试文件；原始数量不等于网页测试记录数量。本场景未覆盖跨日期或同一网址多次访问。
- **保留网站：** 添加 `example.com` 后，结果排除该域名下剩余的两条记录，并提示两条匹配网址已保留。本次实际交互未覆盖子域名保护；域名边界及子域名规则另有仓库单元测试覆盖。
- **切换视图：** 小窗当前网站搜索也显示相同的两条 `example.com` 保留记录。带着选择点击打开完整页面时，插件明确提示会开始新搜索、选择不会转移，随后取消了跳转；不能描述成多视图同步选择。测试后已移除保留网站规则。

2026 年 10 月 2 日 UTC，对上述 0.3.2 源码运行的 **52 项单元测试全部通过**；打包检查通过，生成插件和静态网站 ZIP。这些检查与浏览器实际交互分开记录，合成测试不代表真实 Chrome 的处理速度或跨设备行为。

### 10 月 2 日的有限竞品界面复查

Chrome 扩展管理页核实版本：Better History **7.0.0**（`egehpkpgpgooebopjihjmnpejnjafefi`）、History Cleaner Pro by HVS **1.1**（`anljiajpccjocbhocgalcgoafnnkfdpl`）、History Cleaner by Tags **3.2.0**（`ckjjcldcdgcleaiidahlffloopnmjloa`）。这次新会话中，只有 History Sweep 执行了删除。

- **Better History：** 可见日期、小时导航，以及 CSV/HTML 导出、整日删除、域名黑名单、智能自动清理和高级导出入口。搜索 `example.org` 找到剩余的 `example.com/?query=example.org`，符合标题或网址的文字搜索语义，不是缺陷。未执行删除、导出、黑名单或自动清理。
- **HVS：** 搜索 `example` 找到两条剩余测试记录；全选并排除 `keep-this` 后，只剩一条选中。点击删除打开一条历史记录的确认窗口，随后取消。这里验证了搜索、选择和确认，没有新的删除结果。
- **Tags：** Clean 面板显示已有标签及 Clean now；Schedule 有自动清理、启动时清理、仅匹配网址和浏览时清理选项。三个自动清理开关关闭，仅匹配网址开启，下一次运行显示未安排。Options 有设置同步及备份入口。未修改规则、启用计划或执行清理，也未观察到试运行功能。

### 必须保留的边界

- 删除网址会移除它的**全部访问记录**，且无法撤销。日期筛选依据**最后访问时间**选择网址，不意味着仅删除所选时段内的单次访问。
- Chrome 可能跨已登录设备同步删除；本轮未测试同步传播。
- 每次搜索最多读取 100,000 个网址。合成测试通过不代表该规模下的真实历史性能。
- 本轮不证明定时执行、导出完整性、无障碍合规、网络与隐私行为或安全性。
- 单一浏览器和操作系统的结果不能保证其他配置、设备或版本。公开对比不会将单次会话中的异常写成对竞品的普遍判断。
