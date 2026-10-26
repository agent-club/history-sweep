// Shared by the offline extension and the generated website page.
// Release status is preset for the package and its matching website notes.
const copy = (en, zh) => ({ en, 'zh-CN': zh });

export const releaseNotes = [
  {
    version: '0.6.0', status: 'published',
    title: copy('Cleanup on your schedule, a workspace of your own', '按计划清理，按习惯使用'),
    changes: [
      copy('Create local cleanup tasks with one-time, daily, weekly or monthly schedules and optional inactivity conditions. Preview before enabling; kept websites take priority. Browser shutdown or sleep can delay execution.', '创建本机清理任务，支持单次、每日、每周、每月定时及可选的未访问天数条件。启用前先预览，保留网站优先；浏览器关闭或休眠可能延迟执行。'),
      copy('Manage cleanup tasks and WebDAV backups in the same settings window. Reorder or hide browsing views, and review unsaved preferences before closing.', '在同一设置窗口中管理清理任务和 WebDAV 备份；调整浏览视图顺序或显隐，关闭前确认未保存的偏好。'),
      copy('Copy a full URL without changing selection. Expand local activity in place, and hide cleanup activity with Soft privacy while keeping its records.', '复制完整网址而不改变勾选；在原处展开本地活动，通过软隐私隐藏清理活动，同时保留记录。'),
      copy('Receive a local nameplate with a one-time first-install reveal. Replay it from the card icon; reduced motion skips the entrance animation.', '领取本机专属铭牌，新安装首次打开时展示一次开卡动画；可从卡片图标重播，减少动态效果时跳过入场动画。'),
      copy('Open Quick start and offline release notes from Preferences. Version & updates separates published versions from Chrome-ready downloads and protects active work before reloading.', '从偏好设置打开快速开始和离线更新记录；版本与更新区分公开新版与 Chrome 已下载更新，重新加载前保护正在进行的操作。'),
    ],
  },
  {
    version: '0.5.0', status: 'published',
    title: copy('More ways to browse and keep your preferences', '更多浏览方式与偏好备份'),
    changes: [
      copy('Browse by visit frequency within a chosen period. Choose your default view and date range.', '按所选时间段内的访问频次浏览，可设置默认视图与日期范围。'),
      copy('Private cleanup skips saving new cleanup activity. Return to the top of long results with one click.', '无痕清理可停止保存新的清理活动；长列表支持一键回到顶部。'),
      copy('Manually transfer lightweight preferences with WebDAV, or save an encrypted disk backup. Browsing history is excluded.', '通过 WebDAV 手动传输轻量偏好，或保存加密磁盘备份，不包含浏览历史。'),
    ],
  },
  {
    version: '0.4.0', status: 'published',
    title: copy('A clearer history workspace', '更清晰的历史工作区'),
    changes: [
      copy('Review browsing and verified cleanup activity by year or three months, with daily website summaries stored locally.', '按全年或三个月查看浏览与已验证的清理活动，网站日摘要保存在本机。'),
      copy('Switch between date and website groups without losing your selection. Browse the last three local calendar days by default.', '在日期与网站分组间切换并保留选择，默认浏览最近三个本地自然日。'),
      copy('Delete a single row while keeping a batch selection. Clearer deletion feedback and automatic refresh when idle.', '删除单条记录时保留批量选择，优化删除反馈，并在空闲时自动刷新结果。'),
      copy('Choose automatic, light or dark appearance across extension views.', '在各扩展视图中选择自动、浅色或深色外观。'),
    ],
  },
  {
    version: '0.3.2', status: 'archive',
    title: copy('Date filters and website shortcuts', '日期筛选与网站快捷入口'),
    changes: [
      copy('Filter by local dates and review selected URLs grouped by website before deletion.', '按本地日期筛选，删除前按网站核对选中的网址。'),
      copy('Keep chosen domains and their subdomains out of cleanup. Start an exact-host search from the current website or its right-click menu.', '保留指定域名及其子域名；从当前网站或右键菜单发起精确域名搜索。'),
      copy('Choose popup, in-page modal or full-page opening. Store installs can show an update-ready banner.', '可选择弹窗、页面内浮窗或完整页面；商店安装支持更新就绪提示。'),
    ],
  },
  {
    version: '0.3.1', status: 'published',
    title: copy('Website groups and local suggestions', '网站分组与本地搜索建议'),
    changes: [
      copy('Search suggestions come from local history. Group results by website and select whole groups.', '搜索建议来自本机历史，支持按网站分组和整组选择。'),
      copy('Normalize title and URL text for matching, and show feedback after verified deletion.', '对标题与网址文字进行规范化匹配，并在删除验证后显示完成反馈。'),
    ],
  },
  {
    version: '0.3.0', status: 'archive',
    title: copy('Search, review and clear selected history', '搜索、核对并清理选中的历史'),
    changes: [
      copy('Search Chrome history by domain, title or URL, then select and confirm the URLs to delete.', '按域名、标题或网址搜索 Chrome 历史，选择网址后确认删除。'),
      copy('Use the popup or full workspace in English or Simplified Chinese. Confirmed deletion continues in the background while Chrome stays open.', '提供中英文弹窗与完整工作区；Chrome 保持运行时，已确认的删除可在后台继续。'),
    ],
  },
];

const labels = {
  title: copy('Release notes', '更新记录'),
  scope: copy('Each record describes a package. Check your installed version before comparing features.', '每条记录说明对应安装包的变化，比较功能前请先核对已安装版本。'),
  candidate: copy('Candidate · not confirmed public', '候选版 · 尚未确认公开'),
  published: copy('Published', '已发布'),
  archive: copy('Archived package', '历史安装包'),
  candidateHint: copy('Prepared for release. Public availability is not yet confirmed.', '已准备发布，尚未确认公开提供。'),
  archiveHint: copy('Reconstructed from the archived package. Exact publication dates are not recorded here.', '依据历史安装包补录，此处不推定具体发布日期。'),
  development: copy('In development', '开发中'),
  developmentTitle: copy('After v0.6.0', 'v0.6.0 之后'),
  developmentHint: copy('Source changes awaiting a future package.', '等待后续打包的源码改动。'),
};

const developmentChanges = [];

const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function releaseNotesMarkup(language) {
  const text = value => escape(value[language] ?? value.en);
  const list = changes => `<ul class="release-changes">${changes.map(change => `<li>${text(change)}</li>`).join('')}</ul>`;
  const records = releaseNotes;
  const latestPublished = records.find(record => record.status === 'published');
  return `<section class="release-history" aria-label="${text(labels.title)}"><h3 class="release-history-title">${text(labels.title)}</h3><p class="release-scope">${text(labels.scope)}</p>${records.map(record => `<details class="release-record" data-release="${record.version}"${record === latestPublished ? ' open' : ''}><summary class="release-summary"><span class="release-version">v${record.version}</span><span class="release-badge" data-status="${record.status}">${text(labels[record.status])}</span></summary><h4 class="release-title">${text(record.title)}</h4>${record.status === 'candidate' ? `<p class="release-note">${text(labels.candidateHint)}</p>` : record.status === 'archive' ? `<p class="release-note">${text(labels.archiveHint)}</p>` : ''}${list(record.changes)}</details>`).join('')}${developmentChanges.length ? `<details class="release-record" data-release="development"><summary class="release-summary"><span class="release-version">${text(labels.development)}</span></summary><h4 class="release-title">${text(labels.developmentTitle)}</h4><p class="release-note">${text(labels.developmentHint)}</p>${list(developmentChanges)}</details>` : ''}</section>`;
}
