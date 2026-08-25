/**
 * 班级站点静态数据
 *
 * ── 如何更新公告 ─────────────────────────────
 * 在 ANNOUNCEMENTS 数组开头加一条即可：
 *   { date: '2026-08-23 14:30', text: '公告内容', important: true/false }
 * date 格式为 'YYYY-MM-DD HH:mm'，时间可精确到分钟（只写日期也行）
 * important: true 会以醒目样式显示并标记「置顶」
 * ─────────────────────────────────────────────
 *
 * ── 如何更新学习资料问答（gate）───────────────
 * gate.version 是「认证版本号」：改动问题/答案/链接后，把 version 改成新值，
 * 所有同学下次打开都会重新答题，旧的通过记录自动失效。
 * ─────────────────────────────────────────────
 */

export interface Announcement {
  date: string
  text: string
  /** 重要公告，高亮显示 */
  important?: boolean
}

export interface SiteCategory {
  id: number
  name: string
}

/** 问答型资源：答对问题后才能看到网盘链接与访问码 */
export interface Gate {
  /** 显示给同学的问题 */
  question: string
  /**
   * 可接受的答案（均为 SHA-256 哈希值，配合 GATE_SALT 使用，不存明文）
   * 输入经「去首尾空格 + 转小写 + 加盐」哈希后比对
   */
  answers: string[]
  /** 答错时显示的提示 */
  hint: string
  /** 答对后展示的网盘链接 */
  url: string
  /** 答对后展示的访问码 */
  code: string
  /** 认证版本号，修改内容后更新此值让所有人重新答题 */
  version: string
}

export interface SiteLink {
  id: number
  categoryId: number
  title: string
  /** 标题下方的平台名称，如 VoiceHub / Classworks */
  subtitle?: string
  description: string
  icon: string
  /** 无图标时显示的占位文字（如「日报」） */
  iconText?: string
  mainLabel: string
  mainUrl: string
  /** 微信内可直接打开 */
  mainWechatOk: boolean
  extraLabel: string
  extraUrl: string
  extraWechatOk: boolean
  /** 问答型资源（有值时不显示普通跳转按钮，改为答题获取访问码） */
  gate?: Gate
  /** 待开发占位入口：按钮点击仅提示，不跳转 */
  comingSoon?: boolean
  /** 联系方式查询入口：显示「输入姓名查联系方式」输入框 */
  contactQuery?: boolean
}

/* ================= 联系方式名单（输入姓名查询） ================= */
// 安全存储：name 为 SHA-256 哈希（CONTACT_SALT），studentId/role/wechat/phone 为 XOR+Base64 密文
// 查询时「姓名哈希」匹配 → 解密显示学号/职位/联系方式；源码中不出现明文名单
export interface Contact {
  /** 姓名（SHA-256 哈希，配合 CONTACT_SALT 比对） */
  name: string
  /** 学号（XOR+Base64 混淆密文，前端解密显示） */
  studentId?: string
  /** 角色（XOR+Base64 混淆密文，如 学生 / 老师 / 管理员） */
  role?: string
  /** 微信号（XOR+Base64 混淆密文，前端解密显示） */
  wechat?: string
  /** 电话（XOR+Base64 混淆密文，前端解密显示） */
  phone?: string
}

/* ================= 站点入口问答（首次打开需回答才能进入） ================= */
// answers 为 SHA-256 哈希（GATE_SALT），不存明文；version 变更后所有人需重新答题
export const SITE_GATE = {
  question: '请回答举办“给未来自己的一封信”当天所对应的节日。',
  answers: ['725f83c579b242c8f55fd871f950c2b87f06e0d05f66065d658d1a74e7d06c80'],
  hint: '三个字',
  version: '2026-08-23-v1',
}

export const CONTACTS: Contact[] = [
  { name: '6edf6fc48db2cecbe826594996f606fb1f99f32a96944c311a4b437a4267b004', studentId: 'UVlDBwUB', role: 'hsHV1aGv' },
  { name: '338a66cc44808e94fae8f8f23ec355d4bd1118e1e089b0219c1e295330e6f5a3', studentId: 'UVlDBwUC', role: 'hsHV1aGv' },
  { name: 'b3e8a4374d79896ce4ea5515a1f04a2ab9739c93ce0de00de65c3fe745c469f1', studentId: 'UVlDBwUD', role: 'hsHV1aGv' },
  { name: 'cc72fe4139c1594048c067a36054e1bc19ec61f2d81a6a28ad1e8b78b7534bc3', studentId: 'UVlDBwUE', role: 'hsHV1aGv' },
  { name: '53aeba31817d0b9045cd742c55229201d7b39e10aedc744706c405dfe1f5c334', studentId: 'UVlDBwUF', role: 'hsHV1aGv' },
  { name: '253007e4caa94fe764acab32fbe18efb5c2b5fff0b5f1502f4a75a038be23e0e', studentId: 'UVlDBwUG', role: 'hsHV1aGv' },
  { name: '1dbacc13f59db223dee613ce8da9e3a518f6ef934d735ac002f2c71930e9410c', studentId: 'UVlDBwUH', role: 'hsHV1aGv' },
  { name: '4d43235c5a4fc8407a52ee851ac8535043df6462ca0fab5b7afab0f7af423c3c', studentId: 'UVlDBwUI', role: 'hsHV1aGv' },
  { name: '05e5841799618ba25aa49522ee28ec572d197c0f98c9bd26eefcf3ed708e8bca', studentId: 'UVlDBwUJ', role: 'hsHV1aGv' },
  { name: 'a34c850cb97c91d43eae4856748fd6737531a9600b1e1b63ad2362385fe726aa', studentId: 'UVlDBwQA', role: 'hsHV1aGv' },
  { name: '31f53f857eb435a21729b01496b15c4dc118ec93c2add27ba4e36527e0343522', studentId: 'UVlDBwQB', role: 'hsHV1aGv' },
  { name: '8735829c7abf4d3f837cac0cb0de598102bf01803b5e9b7fca75573e59c11572', studentId: 'UVlDBwQC', role: 'hsHV1aGv' },
  { name: '19106232d19044c50a91b7d10af158a6ce8e400964e9e736413974268ee2ea93', studentId: 'UVlDBwQD', role: 'hsHV1aGv' },
  { name: '7a5152e33f5d575f537c8d8069bbec1b4614f6cb93cf47492fe2ba36f83e0d48', studentId: 'UVlDBwQE', role: 'hsHV1aGv' },
  { name: 'ce7d97fec9786c0afbf62e54265ac4c89f7b1fdd291bfaee32a0e2ee3125a93b', studentId: 'UVlDBwQF', role: 'hsHV1aGv' },
  { name: '77ee4fb9ce71c4aef73923c127aa247519ee3b336e3b9d8478cb20759b7e88f8', studentId: 'UVlDBwQG', role: 'hsHV1aGv' },
  { name: 'd787e4b8ccdd6418ae9712b9a174d8cd9b2aa06812972ca95798bc98840cf65e', studentId: 'UVlDBwQH', role: 'hsHV1aGv' },
  { name: '592a6bc0219ff44ba852b8fbc1a54e75bdbdabd31882d42abe30ab1993f1685e', studentId: 'UVlDBwQI', role: 'hMLS1aW20Lzg', wechat: 'GhYYSF4AAB9B', phone: 'UllFAgIABxtPWkA=' },
  { name: '47fa22025171fcc48a86fce9505e6fd887bbc451199faa036a411260965bd156', studentId: 'UVlDBwQJ', role: 'hsHV1aGv' },
  { name: '103cbbfc30f608cf0d050eec932be5091795daa59054e5ee4d139ae016ec5a00', studentId: 'UVlDBwcA', role: 'hsHV1aGv' },
  { name: '0438ef5d9f5a67013379d5658de687f8654e12a2164e21ab5ba61a5c2ddd1ad9', studentId: 'UVlDBwcB', role: 'hsHV1aGv' },
  { name: 'a37fb9acbff3a5d24dd0ca3105e0136c9b9c74da16c80cbb8ee185930d4a38c6', studentId: 'UVlDBwcC', role: 'hsHV1aGv' },
  { name: '163a8e443ba1dd3a581c69bcfc600499ef3ed84420aa3d145d52e9535a0a2c11', studentId: 'UVlDBwcD', role: 'hsHV1aGv' },
  { name: 'abefa25aabcb67678fcc14befe7c23176fe5311c5d64d1c0feffb3d86677fae5', studentId: 'UVlDBwcE', role: 'hsHV1aGv' },
  { name: 'f4d4d76e8dccea25e4c5734625662dae88ddf732444d6b43e8e9332abd13bbd7', studentId: 'UVlDBwcF', role: 'hsHV1aGv' },
  { name: 'c9b354223547e5c56a60647ce3cbd59a1445f0f2f77e62a4a3a7fa2ac4d90829', studentId: 'UVlDBwcG', role: 'hsHV1aGv' },
  { name: '9abce2917d1575c2b7baff8ea2d46b73ad621d2c33cb7d5adbd6604f5d91d861', studentId: 'UVlDBwcH', role: 'hsHV1aGv' },
  { name: 'fab9ca917a9631d034637da2ee7a4194dd587f07dd3f1799fddc39c3662e2afe', studentId: 'UVlDBwcI', role: 'hsHV1aGv' },
  { name: 'd0c645065f1a6393d84b5d8badf03d71e47a9774aa08db880edd2d4e91280480', studentId: 'UVlDBwcJ', role: 'hsHV1aGv' },
  { name: '074cb34db36f904cb51bbb4692dcff4eb4edaa017044c885b22060956e76a7a6', studentId: 'UVlDBwYA', role: 'hsHV1aGv' },
  { name: 'aef402888d32e4be5a387deedbe52e8e96ac89f8d45f5f1e32202a1d7504903f', studentId: 'UVlDBwYB', role: 'hsHV1aGv' },
  { name: 'f188e0221f799a76dfb4b9fbbcb40351981f074e89f2494f65cfa3a711ef31be', studentId: 'UVlDBwYC', role: 'hsHV1aGv' },
  { name: 'baa39eb61639b988b6cc6ae630b1dabe1e7e1134ac2ec7b8507cf7b1441d5ec2', studentId: 'UVlDBwYD', role: 'hsHV1aGv' },
  { name: '130bd3a6c1d31f5bdd1d1e9b15932f038c43b10e97bca97bb28a99a7d9ee4cf1', studentId: 'UVlDBwYE', role: 'hsHV1aGv' },
  { name: '805100b3f9cbeb454b3cf0365a501bd1702f32ee6e62f59ee0272c5ac6d6dfa7', studentId: 'UVlDBwYF', role: 'hsHV1aGv' },
  { name: 'c8008d219325679dddbe70d5a65d2ea8e9b9614a9aab0590c3edb1f6a6bb84b0', studentId: 'UVlDBwYG', role: 'hsHV1aGv' },
  { name: 'd6c898b609f08ee086e1d40674b4b7df43f18767c68203613043317bff33462e', studentId: 'UVlDBwYH', role: 'hsHV1aGv' },
  { name: '08095bac5639a83842bb220f2a5543d6759483c6d9c254806f5ae11816de60ba', studentId: 'UVlDBwYI', role: 'hsHV1aGv' },
  { name: 'de55cab513a67fd49b5e3328127932d7452ee8cd692791dae13d92d1c886b4a6', studentId: 'UVlDBwYJ', role: 'hsHV1aGv' },
  { name: '641fb904f5a45e8796766af7288ea05757ae494719e18199ff467cfe4ff630dd', studentId: 'UVlDBwEA', role: 'hsHV1aGv' },
  { name: 'aa62fed579d48b78bb7423542c70b14e7c467d3bde6316c165e009afb76d1a8f', studentId: 'UVlDBwEB', role: 'hsHV1aGv' },
  { name: 'adc7a8894cc54facf18b7bec45127a4ebaa578eac672ecd7acba0a3aca1e11e2', studentId: 'UVlDBwEC', role: 'hsHV1aGv' },
  { name: '69e5771d48f7e4ac8cb44d03831f6339e692afc4c1f2dbdbb49ae7be8236da5e', studentId: 'UVlDBwED', role: 'hsHV1aGv' },
  { name: '25b1be539510316be9396879a177605296319d76548f6a71c21059a22aac6bca', studentId: 'UVlDBwEE', role: 'hsHV1aGv' },
  { name: '081b046904293a739e10294c453c9d9474d93ecc8b9ce6468818a80bdd746ad6', studentId: 'UVlDBwEF', role: 'hsHV1aGv' },
  { name: 'eb50343bceb91db7c9fe8287c3dd04713a41d4788e7a4df02a30c7e941ac91fa', studentId: 'UVlDBwEG', role: 'hsHV1aGv' },
  { name: '2b7c3edf81913935d760ca09824064acf8f138352e1bf1f7b315e3802396ac70', studentId: 'UVlDBwEH', role: 'hsHV1aGv' },
  { name: '5ccdaa717a2dd3672fa66c1681a4384413dc18a15647d0b423f7ca99efc081da', studentId: 'UVlDBwEI', role: 'hsHV1aGv' },
  { name: '7e64be7e4c8bb53d115cd502684f18e821f7cedb8b5220727678d7a7135cf35e', studentId: 'UVlDBwEJ', role: 'hsHV1aGv' },
  { name: 'f331461ef257250b14174bd6cf695b5fa8e386bba2ecf59b1785de10aa9f20b9', studentId: 'UVlDBwAA', role: 'hsHV1aGv' },
  { name: '64e30ead116c6bbabf31156a4d2781a1fae62e37ce23f2d11ae9df67fb2aa5bb', studentId: 'UVlDBwAB', role: 'hsHV1aGv' },
  { name: 'db12712ba46cb88d0bf6bef56d22d8a44770d6f522e129d111c43fa6ecd17f8d', studentId: 'UVlDBwAC', role: 'hsHV1aGv' },
  { name: '4dc4bdc87a96b1f945f8a1b57653829999b6ee2ef2e0791949b12a0afc5a36a3', studentId: 'UVlDBwAD', role: 'hsHV1aGv' },
  { name: 'b214e7e1b4b19e5a7fcee920c58798f32a28386f938fa4c88561acc9da3c629a', studentId: 'UVlDBwAE', role: 'hsHV1aGv' },
  { name: '9816eb6ae59e1963e01c0d19ede28f3d34d6e53e817dbf097a80449cd31b0887', studentId: 'UVlDBwAF', role: 'hsHV1aGv' },
  { name: 'bdc94bceb46e48a5e75d5f6d326fd6889431c93bed024a7bdf613b6e6ef750a4', studentId: 'UVlDBwAG', role: 'hsHV1aGv' },
  { name: 'b78a6b3376a2257102abcc3a5c22f02a6e8786279f5478fffb211f5647717e12', studentId: 'UVlDBwAH', role: 'hsHV1aGv' },
  { name: '532dee1f87fc7dab143c3f8465c1e0326946c479c027e67e913ed62283b72c06', studentId: 'UVlDBwAI', role: 'hsHV1aGv' },
  { name: '597de027095c241d792c7dbfed025f826fe1619ffb38f679727209f750eeda34', studentId: 'UVlDBwAJ', role: 'hsHV1aGv' },
  { name: '7a331538b75959bc2523bf63d9f024da20440035c4404fc137397a7eb840ddf1', studentId: 'UVlDBwMA', role: 'hsHV1aGv' },
  { name: 'd7a45c427ccb4592fccf36b876a8a704b5b5bfbb3c21df564fb2aebc3e5e64e8', studentId: 'UVlDBwMB', role: 'hsHV1aGv' },
  { name: '6a90186918c176b91d1e2209c4e303c4b8575dc82031f368d194a66aaf00c850', role: 'i+zy1424', wechat: 'AAMcXkJZW0lJVkUV', phone: 'Ul9KBQUCBhlBXEA=' },
]

/* ================= 班级公众号二维码（公告栏旁「公众号」按钮弹出） ================= */
export const WECHAT_QR_URL = '/qrcode.jpg'

/* ================= 班级公告（新的放最上面） ================= */
export const ANNOUNCEMENTS: Announcement[] = [
  {
    date: '2026-08-23 12:37',
    text: '修复倒计时时/分/秒不实时刷新的问题。',
  },
  {
    date: '2026-08-23 12:33',
    text: '修复倒计时实时刷新；其他工具新增番茄时钟。',
  },
  {
    date: '2026-08-23 12:24',
    text: '首页改版：应用入口移至侧边栏；法定节假日已备至 2028 年 6 月。',
  },
  {
    date: '2026-08-23 12:09',
    text: '倒计时重做：精确到月天，点击面板可查看全部重要日期 / 全部法定节假日。',
  },
  {
    date: '2026-08-23 12:00',
    text: '新增暗黑模式：点击页头左上角的月亮/太阳图标即可切换。',
  },
  {
    date: '2026-08-23 11:39',
    text: '站点新增入口问答；私人云盘已接入访问密码验证。',
  },
  {
    date: '2026-08-23 11:34',
    text: '点歌平台与听歌平台用途说明已修正；其他工具入口文案优化。',
  },
  {
    date: '2026-08-23 11:31',
    text: '点歌平台说明已更新；其他工具新增「私人云盘」占位入口。',
  },
  {
    date: '2026-08-23 11:25',
    text: '板块整理：新增「班级事务」「其他工具」，每日日报移至首页公告下方。',
  },
  {
    date: '2026-08-23 11:16',
    text: '联系方式已更新为班级通讯录（含学号与职位），欢迎查询。',
  },
  {
    date: '2026-08-23 11:04',
    text: '联系方式说明已更新：采用加密存储，无需担心泄露。',
  },
  {
    date: '2026-08-23 10:58',
    text: '学习资料问答与联系方式已升级为加密存储，数据更安全。',
  },
  {
    date: '2026-08-23 10:53',
    text: '已新增联系人，可在「其他」-「联系方式」中查询。',
  },
  {
    date: '2026-08-23 10:48',
    text: '新增「其他」板块：联系方式、情况反映、建言献策、排行榜、班级活动。',
  },
  {
    date: '2026-08-23 10:42',
    text: '学习资料问答题目已更新，如有通过记录失效请重新答题。',
  },
  {
    date: '2026-08-23 10:36',
    text: '修复课堂笔记、教学课件网盘链接，欢迎重新查看。',
  },
  {
    date: '2026-08-23 10:29',
    text: '新增「学习资料」板块：课堂笔记、教学课件，答对班级小问题即可获取网盘链接与访问码。',
  },
  {
    date: '2026-08-23 10:09',
    text: '每日日报入口已更新，班级应用新增 EchoMusic 听歌平台。',
  },
  {
    date: '2026-08-23 00:22',
    text: '经过我这么久的调试这个网站终于有点雏形在了！(╥╯﹏╰╥)ง',
  },
  {
    date: '2026-08-22',
    text: '点歌平台入口已开放！微信内无法直接访问，点击「前往入口」后请按引导用浏览器打开。',
  },
  {
    date: '2026-08-22',
    text: '班级服务站 2.0 上线：新增公告栏；站点可在微信内直接打开，部分国外站点会自动引导用浏览器访问。',
  },
]

/* ================= 板块分类 ================= */
export const CATEGORIES: SiteCategory[] = [
  { id: 1, name: '常用服务' },
  { id: 2, name: '班级应用' },
  { id: 5, name: '学习资料' },
  { id: 3, name: '成绩查询' },
  { id: 7, name: '班级事务' },
  { id: 8, name: '其他工具' },
]

/* ================= 服务卡片 ================= */
export const LINKS: SiteLink[] = [
  {
    id: 1,
    categoryId: 1,
    title: '点歌平台',
    subtitle: 'VoiceHub',
    description:
      '线上点歌平台：点击下方按钮进入，点播你想听的歌曲。\n本平台由 VoiceHub 提供技术支持\n初始账号：学号（如 250501），默认密码：生日（如 20250901）',
    icon: 'https://s41.ax1x.com/2026/08/21/pmxXJkq.png',
    mainLabel: '前往入口',
    mainUrl: 'https://xsyzc2505.dpdns.org/',
    mainWechatOk: false,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
  },
  {
    id: 2,
    categoryId: 1,
    title: '作业查看',
    subtitle: 'Classworks',
    description:
      '周作业及假期作业均可在线查看。\n使用教程：点击页面中的「已注册」，即可自动登录。\n若未显示当周作业，请跳转到布置作业的当天重新查看。',
    icon: 'https://s41.ax1x.com/2026/08/21/pmxX87n.png',
    mainLabel: '前往入口',
    mainUrl:
      'https://cs.houlang.cloud/?namespace=%E9%AB%98%E4%BA%8C%EF%BC%885%EF%BC%89%E7%8F%AD&authCode=202505&autoExecute=true&config=eyJzZXJ2ZXIuYXV0aERvbWFpbiI6Imh0dHBzOi8va3YuaG91bGFuZy5jbG91ZCIsInNlcnZlci5jbGFzc051bWJlciI6IumrmOS4ieWFq%2BePrSIsInNlcnZlci5kb21haW4iOiJodHRwczovL2t2LXNlcnZpY2Uud3V5dWFuLmRldiIsInNlcnZlci5wcm92aWRlciI6ImNsYXNzd29ya3NjbG91ZCIsInNlcnZlci5zaXRlS2V5IjoiIn0%3D',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
  },
  {
    id: 3,
    categoryId: 2,
    title: '班级课表',
    subtitle: 'ClassIsland',
    description:
      '开源智能大屏课表系统，\n实时展示当日课程、上下课倒计时与提醒，\n支持多周轮换课表与临时调课功能。',
    icon: 'https://s41.ax1x.com/2026/08/21/pmxjpEn.png',
    mainLabel: '前往官方页面',
    mainUrl: 'https://www.classisland.tech/',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
  },
  {
    id: 6,
    categoryId: 2,
    title: '屏幕批注',
    subtitle: 'ICC-CE',
    description:
      '智能课堂绘图增强工具，\n专为教师打造高效交互式绘图解决方案，\n支持智能笔迹处理、PPT 实时标注、多点触控手势与高度自定义设置。',
    icon: 'https://s41.ax1x.com/2026/08/22/pmz6J6U.png',
    mainLabel: '前往官方页面',
    mainUrl: 'https://cjk-is-so-cute.netlify.app/',
    mainWechatOk: false,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
  },
  {
    id: 7,
    categoryId: 2,
    title: '听歌平台',
    subtitle: 'EchoMusic',
    description:
      '音乐课等课上播放歌曲的桌面播放器，\n支持歌单分享、歌词同步、主题换肤与多平台音乐导入，\n可在教室电脑安装使用，课上一起听歌更自在。',
    icon: '/echomusic-icon.png',
    mainLabel: '查看项目',
    mainUrl: 'https://github.com/hoowhoami/EchoMusic',
    mainWechatOk: false,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
  },
  {
    id: 8,
    categoryId: 5,
    title: '课堂笔记',
    iconText: '笔记',
    description:
      '经多方对比，课件资源存储于天翼云盘。\n需登录天翼云盘网页端，无需安装客户端，下载基本不限速。\n笔记为截图，可在线预览，加载卡顿建议下载查看。\n打不开可复制链接至浏览器打开（微信页面可能存在兼容问题）。',
    icon: '',
    mainLabel: '',
    mainUrl: '',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
    gate: {
      question: '请回答本班科任男女人数之比（共10人）',
      answers: [
        'ac18bd73597efe3e39320f1c78d6fa7d8baacb81e29b4db28638146a16894e2c',
        '7321b13f59cde5cf414fe889f0cc93d3912387dad2ee1097dd25365e1e0867fc',
      ],
      hint: '四字，格式为「男_女_」',
      url: 'https://cloud.189.cn/t/EbEzInJnQBzq',
      code: '7xlk',
      version: '2026-08-23-v3',
    },
  },
  {
    id: 9,
    categoryId: 5,
    title: '教学课件',
    iconText: '课件',
    description:
      '经多方对比，课件资源存储于天翼云盘。\n需登录天翼云盘网页端，无需安装客户端，下载基本不限速。\n打不开可复制链接至浏览器打开（微信页面可能存在兼容问题）。',
    icon: '',
    mainLabel: '',
    mainUrl: '',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
    gate: {
      question: '请回答在高一下学期中零排的常驻嘉宾是？',
      answers: ['9d782e21981e703e909d86136724dea48c956e805bf3be2fc69652c697ee626e'],
      hint: '三个字，全名',
      url: 'https://cloud.189.cn/t/zYJnEfBnIj22',
      code: 'pap9',
      version: '2026-08-23-v3',
    },
  },
  {
    id: 4,
    categoryId: 0,
    title: '每日日报',
    description: '每日时事热点速览，\n点击下方按钮即可查看当日热点内容。',
    icon: '',
    iconText: '日报',
    mainLabel: '前往查看',
    mainUrl: 'https://a288a58108efc2c2f.app.workbuddy.link',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
  },
  {
    id: 5,
    categoryId: 3,
    title: '高一下学期期末考',
    subtitle: '易查分',
    description: '',
    icon: '',
    iconText: '成绩',
    mainLabel: '查询成绩',
    mainUrl: 'https://u5p5aq6d.yichafen.com/qz/166mKITWTt',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
  },
  {
    id: 10,
    categoryId: 8,
    title: '联系方式查询',
    iconText: '联系',
    description: '输入姓名，快速查询同学、老师的联系方式。\n联系方式采用加密存储，不用担心泄露。',
    icon: '',
    mainLabel: '',
    mainUrl: '',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
    contactQuery: true,
  },
  {
    id: 16,
    categoryId: 8,
    title: '番茄时钟',
    iconText: '🍅',
    description:
      '番茄工作法计时器：专注 25 分钟 + 短暂休息，\n帮你提升学习效率，保持专注。',
    icon: '',
    mainLabel: '前往使用',
    mainUrl: 'https://focustide.app/',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
  },
  {
    id: 15,
    categoryId: 8,
    title: '私人云盘',
    iconText: '云盘',
    description: '用于同步班级重要文件、应用与软件，方便随时取用。',
    icon: '',
    mainLabel: '',
    mainUrl: '',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
    gate: {
      question: '请输入私人云盘的访问密码',
      answers: ['5e67cd33facc7b1ac3169e55cd8b161c655cc939c6f9322c0f56919ffaa432c3'],
      hint: '仅管理员持有访问密码',
      url: '',
      code: '',
      version: '2026-08-23-v1',
    },
  },
  {
    id: 11,
    categoryId: 7,
    title: '情况反映',
    iconText: '反映',
    description:
      '说说班上令你厌恶的点，匿名反映。\n如果是投稿班级建议，请点击「建言献策」。',
    icon: '',
    mainLabel: '待开发',
    mainUrl: '',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
    comingSoon: true,
  },
  {
    id: 12,
    categoryId: 7,
    title: '建言献策',
    iconText: '建议',
    description:
      '针对班上你有什么好的意见或想法。\n如果是投稿班上不好的事情，请点击「情况反映」。',
    icon: '',
    mainLabel: '待开发',
    mainUrl: '',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
    comingSoon: true,
  },
  {
    id: 13,
    categoryId: 7,
    title: '排行榜',
    iconText: '排行',
    description: '班级排行榜功能开发中，敬请期待。',
    icon: '',
    mainLabel: '开发中',
    mainUrl: '',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
    comingSoon: true,
  },
  {
    id: 14,
    categoryId: 7,
    title: '班级活动',
    iconText: '活动',
    description: '暂时还没有班级活动，敬请期待。',
    icon: '',
    mainLabel: '敬请期待',
    mainUrl: '',
    mainWechatOk: true,
    extraLabel: '',
    extraUrl: '',
    extraWechatOk: true,
    comingSoon: true,
  },
]

/* ================= 重要日期倒计时配置 ================= */
// 「重要日期」精确到月和天；点击面板可查看全部列表
export interface ImportantDate {
  name: string
  date: string
}
export const IMPORTANT_DATES: ImportantDate[] = [
  { name: '报到', date: '2026-08-31T18:00:00' },
  { name: '寒假', date: '2027-01-30T00:00:00' },
]

/* ================= 法定节假日倒计时（精确到天） ================= */
// date 为节假日当天；days 为放假天数（以官方最终通知为准，可在此修改）
// 已收录至 2028 年 6 月，过期条目会自动隐藏，无需删除
export interface Holiday {
  name: string
  date: string
  days: number
}
export const HOLIDAYS: Holiday[] = [
  { name: '中秋节', date: '2026-09-25', days: 3 },
  { name: '国庆节', date: '2026-10-01', days: 8 },
  { name: '元旦', date: '2027-01-01', days: 3 },
  { name: '春节', date: '2027-02-06', days: 7 },
  { name: '清明节', date: '2027-04-05', days: 3 },
  { name: '劳动节', date: '2027-05-01', days: 5 },
  { name: '端午节', date: '2027-06-09', days: 3 },
  { name: '中秋节', date: '2027-09-15', days: 3 },
  { name: '国庆节', date: '2027-10-01', days: 8 },
  { name: '元旦', date: '2028-01-01', days: 3 },
  { name: '春节', date: '2028-01-26', days: 7 },
  { name: '清明节', date: '2028-04-04', days: 3 },
  { name: '劳动节', date: '2028-05-01', days: 5 },
  { name: '端午节', date: '2028-05-28', days: 3 },
]
