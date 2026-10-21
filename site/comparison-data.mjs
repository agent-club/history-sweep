// Limits are scoped to the displayed workflow. Visual assessments are editorial,
// based on public interface images, not a usability study or a current-build replay.
export const comparisonClaims = {
  clickandclean: {
    tagline:['Coarse cleanup. History exceptions get left out.','按类型清理，历史例外留不住。'],
    rows:[
      [['Category cleanup is coarser.','按类型清，粒度更粗。'],['The documented flow selects data types, not individual history URLs.','官方流程选择历史等数据类型，再统一删除；这一操作无法逐页取舍。']],
      [['Its whitelist still deletes history.','白名单也会删掉历史。'],['The guide explicitly excludes history from whitelist protection.','官方明确：白名单保站点数据，浏览历史仍会被删除。']],
      [['Flat checkboxes, weaker hierarchy.','传统表单，视觉层级更平。'],['The public settings image stacks peer-level data-type checkboxes.','官方图把数据类型复选框平铺，缺少按网站、记录组织的阅读层次。']],
      [['Configure here. Clean somewhere else.','配置与执行分开，来回找。'],['The guide moves from popup to settings, saves preferences, then returns to cleanup.','官方流程先进入设置选类型、保存，再回弹窗执行；选择过程更割裂。']],
    ],
    caption:['Limits of the documented cleanup workflow.','以上对应官方指南里的清理流程。'],
    source:'https://browsernative.com/click-and-clean-chrome-extension/',
  },
  betterhistory:{
    tagline:['More management controls. A less focused cleanup path.','管理入口更多，精细清理主线更分散。'],
    rows:[
      [['Text search can include mere mentions.','文字搜索会混入提及项。'],['The dated test matched another site’s query string; it required further filtering.','旧实测搜索 example.org 也命中别站参数，需要进一步筛选。']],
      [['Its keep rules target automatic cleanup.','白名单偏向自动清理保护。'],['Selected deletion also works. Its documented whitelist protects scheduled cleanup.','它同样支持选中删除；官方白名单主要针对自动清理，使用路径不同。']],
      [['Navigation and export compete for attention.','导航、导出同屏，清理主线更散。'],['Public images put date navigation, export and deletion controls in one workspace.','官图中日期导航、导出与删除入口同屏；单一清理任务的视觉竞争更多。']],
      [['More time-navigation controls to scan.','日期、小时双层导航，读屏更忙。'],['This is a visual assessment of the public layout; light/dark themes are supported.','官图同时显示日期条、小时条和记录。支持浅／深色，但布局仍偏管理工作台。']],
    ],
    caption:['Scoped to text search, keep rules and the public layout.','对照文字搜索、保留规则与官方展示布局。'],
    source:'https://betterhistory.io/',
  },
  clearcache:{
    tagline:['More site-data configuration before a history decision.','站点数据配置更重，逐页历史清理更间接。'],
    rows:[
      [['Scope controls, but no target list in this view.','范围能配置，目标页不在这一屏。'],['The public settings view configures data types, domains and time, rather than listing history URLs.','官图先配置类型、域名与时间，没有在同一设置屏列出目标历史网址。']],
      [['Preview does not establish per-page keeping.','能预览，逐页保留仍待核实。'],['Preview is documented; excluding individual history URLs has not been verified.','已提供预览；能否像记录列表一样逐网址排除，尚未验证。']],
      [['Modern theme, configuration-led layout.','主题现代，布局仍偏配置。'],['A modern theme is present; the pictured main screen emphasizes settings over record hierarchy.','官图已有现代主题；主界面重心仍在设置，而非历史记录的分层阅读。']],
      [['More parallel settings to scan.','清理、行为、自动化并排，扫读更重。'],['Those three groups share the public settings screen, increasing detail for a small cleanup task.','官图三组配置同时呈现；只想清理几条历史时，需要辨认的信息更多。']],
    ],
    caption:['Compared with its public settings and preview workflow.','对照官方设置图与清理预览流程。'],
    source:'https://chromewebstore.google.com/detail/clear-cache/cppjkneekbjaeellbfkmgnhonkkjfpdn?hl=en',
  },
  oneclick:{
    tagline:['Data-type cleanup leaves finer page decisions indirect.','按数据类型整理，逐页取舍更间接。'],
    rows:[
      [['Category and time, rather than target URLs.','按类别与时段，目标粒度更粗。'],['The public screen selects data categories and a time span; no URL results are shown there.','官图选择数据类型和时段，这一屏没有逐网址结果列表。']],
      [['No per-page exception shown.','展示流程里，没有逐页留下。'],['The listed workflow cleans categories; per-history-URL exception handling remains unverified.','公开流程围绕类别清理，单条历史例外的处理仍需实测。']],
      [['Traditional form, flatter visual hierarchy.','传统表单，视觉层级更平。'],['The store image uses dense text, checkboxes and inline instructions.','商店图以密集文字、复选框和行内说明为主，清理重点不够突出。']],
      [['Small type and many peer-level options.','小字与选项密排，扫读更费眼。'],['A visual assessment of the public image, not a measured eye-strain claim.','按官方展示图判断：多种数据选项紧密排列，查找和核对的视觉负担更高。']],
    ],
    caption:['Based on the interface currently displayed in its listing.','对照商店当前展示的界面图，非最新版本运行截图。'],
    source:'https://chromewebstore.google.com/detail/oneclick-cleaner-for-chro/oncckmaelaecccmaniihojgeopkcajfh?hl=en',
  },
  clickclean:{
    tagline:['More tools to identify before you reach the task.','入口更多，目标历史要再找。'],
    rows:[
      [['Find the history tool before the records.','先辨认工具，再找目标记录。'],['The official main-menu image presents history among several cleanup tools.','官网主菜单图把历史与多种工具并列，目标记录不在第一层。']],
      [['A current-page action is not per-page keeping.','当前页清理，不等于逐页保留。'],['A viewer and “Forget this Page” are documented; an exception-review workflow is unverified.','已有查看器与当前页操作；逐页留下例外的核对流程尚未验证。']],
      [['Colorful tiles compete with the cleanup task.','彩色磁贴抢眼，清理层级更散。'],['The official menu image mixes several colored tool tiles.','官网展示图采用多色工具磁贴，同级入口较多，视觉注意更分散。']],
      [['Many entry points in a compact panel.','小面板入口密集，辨认负担更高。'],['A visual assessment of the official image; other views may differ.','仅针对官网主菜单图：先寻找工具，再进入操作，其他视图可能不同。']],
    ],
    caption:['Visual observations refer to the official menu image.','视觉判断对应官网展示图，不推定为最新版本界面。'],
    source:'https://www.hotcleaner.com/clickclean_chrome.html',
  },
};

export const comparisonProducts = [
  {key:'clickandclean',name:'Click and Clean',maker:'BrowserNative',users:'100,000'},
  {key:'clickclean',name:'Click&Clean',maker:'Hotcleaner / Mixesoft',users:'1,000,000'},
  {key:'clearcache',name:'Clear Cache',maker:'Little Void LLC',users:'1,000,000'},
  {key:'betterhistory',name:'Better History',maker:'betterhistory.io',users:'100,000'},
  {key:'oneclick',name:'OneClick Cleaner',maker:'Smart Software',users:'100,000'},
];
