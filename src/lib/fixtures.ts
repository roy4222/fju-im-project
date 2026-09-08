/**
 * 原型共用假資料。
 *
 * 這份 fixture 是**單一來源**：學生／老師／管理員三個 Dashboard 都讀同一份資料，
 * 差別只在權限與視角。這樣才看得出 MOC §2.2 權限矩陣在畫面上的真實差異。
 *
 * 型別刻意貼近 MOC §12 的核心資料模型命名（ManagedItem、GroupResponse、
 * SubmissionVersion、GradingSchemeVersion…），之後接 Drizzle schema 時可直接對照。
 *
 * 全部是虛構資料：姓名、學號、公司、Email 均為示範用，不含任何真實個資。
 */

export type Role = "student" | "teacher" | "admin";

export const COHORT = {
  code: "114",
  label: "114 學年度（2026）",
  status: "active" as const,
};

/* -------------------------------------------------------------------------- */
/* 使用者                                                                      */
/* -------------------------------------------------------------------------- */

export type Person = {
  id: string;
  name: string;
  studentNo?: string;
  email: string;
  roles: Role[];
};

export const CURRENT_USERS: Record<Role, Person> = {
  student: {
    id: "u-401",
    name: "林彥廷",
    studentNo: "411410123",
    email: "411410123@m365.fju.edu.tw",
    roles: ["student"],
  },
  teacher: {
    id: "u-102",
    name: "陳建宏",
    email: "chen.ch@mail.fju.edu.tw",
    roles: ["teacher"],
  },
  admin: {
    id: "u-001",
    name: "系辦管理員",
    email: "im-office@mail.fju.edu.tw",
    roles: ["admin", "teacher"],
  },
};

export const TEACHERS: Person[] = [
  { id: "u-102", name: "陳建宏", email: "chen.ch@mail.fju.edu.tw", roles: ["teacher"] },
  { id: "u-103", name: "王雅玲", email: "wang.yl@mail.fju.edu.tw", roles: ["teacher"] },
  { id: "u-104", name: "李孟儒", email: "lee.mj@mail.fju.edu.tw", roles: ["teacher"] },
  { id: "u-105", name: "張士豪", email: "chang.sh@mail.fju.edu.tw", roles: ["teacher"] },
];

/* -------------------------------------------------------------------------- */
/* 組別                                                                        */
/* -------------------------------------------------------------------------- */

export type GroupType = "GENERAL" | "INDUSTRY";

export type Member = {
  id: string;
  name: string;
  studentNo: string;
  isLeader?: boolean;
  confirmed: boolean;
};

export type Group = {
  id: string;
  no: string;
  title: string;
  type: GroupType;
  advisorId: string | null;
  members: Member[];
  industryId?: string;
  status: "forming" | "active" | "exception";
};

export const MY_GROUP: Group = {
  id: "g-07",
  no: "第 07 組",
  title: "校園閒置空間共享媒合平台",
  type: "GENERAL",
  advisorId: "u-102",
  status: "forming",
  members: [
    { id: "u-401", name: "林彥廷", studentNo: "411410123", isLeader: true, confirmed: true },
    { id: "u-402", name: "黃詩涵", studentNo: "411410145", confirmed: true },
    { id: "u-403", name: "吳柏諺", studentNo: "411410167", confirmed: true },
    { id: "u-404", name: "蔡育瑄", studentNo: "411410189", confirmed: false },
    { id: "u-405", name: "鄭凱文", studentNo: "411410201", confirmed: false },
  ],
};

export const GROUPS: Group[] = [
  MY_GROUP,
  {
    id: "g-01",
    no: "第 01 組",
    title: "醫療院所排班最佳化系統",
    type: "GENERAL",
    advisorId: "u-103",
    status: "active",
    members: mkMembers("41141", 300, ["周子瑜", "許哲瑋", "潘映璇", "簡宇軒", "邱郁婷"]),
  },
  {
    id: "g-02",
    no: "第 02 組",
    title: "零售門市補貨預測（產學：宏昇物流）",
    type: "INDUSTRY",
    advisorId: "u-102",
    industryId: "ind-01",
    status: "active",
    members: mkMembers("41141", 310, ["賴威廷", "宋佳蓉", "馮柏勳", "涂雅雯", "石承翰"]),
  },
  {
    id: "g-03",
    no: "第 03 組",
    title: "非營利組織捐款流程數位化（產學：光晨社福）",
    type: "INDUSTRY",
    advisorId: null,
    industryId: "ind-02",
    status: "active",
    members: mkMembers("41141", 320, ["方品瑄", "游承翰", "廖珮綺", "康柏融", "詹于萱"]),
  },
  {
    id: "g-04",
    no: "第 04 組",
    title: "校內活動報名與簽到整合",
    type: "GENERAL",
    advisorId: "u-104",
    status: "active",
    members: mkMembers("41141", 330, ["溫子謙", "范芷妍", "杜宥安", "洪思語", "莊博凱"]),
  },
  {
    id: "g-05",
    no: "第 05 組",
    title: "二手教科書交易平台",
    type: "GENERAL",
    advisorId: "u-105",
    status: "active",
    members: mkMembers("41141", 340, ["田家瑜", "阮柏毅", "曾語彤", "崔浩然", "翁苡榛"]),
  },
  {
    id: "g-06",
    no: "第 06 組",
    title: "工廠設備稼動率可視化（產學：昱鋼精機）",
    type: "INDUSTRY",
    advisorId: null,
    industryId: "ind-03",
    status: "active",
    members: mkMembers("41141", 350, ["何昀諠", "商柏睿", "藍怡萱", "傅子齊", "涂宥辰"]),
  },
  {
    id: "g-08",
    no: "第 08 組",
    title: "長照機構家屬溝通看板",
    type: "GENERAL",
    advisorId: "u-103",
    status: "active",
    members: mkMembers("41141", 370, ["巫佳蓁", "郝彥丞", "岳庭妤", "解軍豪", "麥若彤"]),
  },
  {
    id: "g-09",
    no: "第 09 組",
    title: "跨境電商稅務試算工具",
    type: "GENERAL",
    advisorId: null,
    status: "exception",
    members: mkMembers("41141", 380, ["柯亦辰", "宮宇薇", "潘冠霖", "尤思穎"]),
  },
];

function mkMembers(prefix: string, base: number, names: string[]): Member[] {
  return names.map((name, i) => ({
    id: `u-${base + i}`,
    name,
    studentNo: `${prefix}0${base + i}`,
    isLeader: i === 0,
    confirmed: true,
  }));
}

export const UNGROUPED = [
  { id: "u-501", name: "應宥丞", studentNo: "411410411", openToJoin: true },
  { id: "u-502", name: "解雨萱", studentNo: "411410422", openToJoin: true },
  { id: "u-503", name: "鞠柏宇", studentNo: "411410433", openToJoin: false },
  { id: "u-504", name: "冷佳霓", studentNo: "411410444", openToJoin: true },
];

/* -------------------------------------------------------------------------- */
/* 專題事務項目（ManagedItem）                                                  */
/* -------------------------------------------------------------------------- */

export type Placement =
  | "news"
  | "resource"
  | "submission"
  | "requirement"
  | "rules"
  | "showcase"
  | "honor";

export const PLACEMENT_LABEL: Record<Placement, string> = {
  news: "公告／最新消息",
  resource: "檔案／資源下載",
  submission: "文件繳交",
  requirement: "專題需求",
  rules: "專題規則",
  showcase: "歷屆／優秀專題",
  honor: "榮譽／競賽",
};

export type SubmissionState =
  | "todo"
  | "draft"
  | "submitted"
  | "resubmit"
  | "overdue"
  | "locked";

export const STATE_LABEL: Record<SubmissionState, string> = {
  todo: "未開始",
  draft: "草稿",
  submitted: "已繳交",
  resubmit: "需重送",
  overdue: "已逾期",
  locked: "已鎖定",
};

export type ManagedItem = {
  id: string;
  title: string;
  placement: Placement;
  summary: string;
  publishedAt: string;
  dueAt?: string;
  audience: string;
  status: "draft" | "published" | "archived";
  schemaVersion?: number;
  /** 學生視角：我這組的狀態 */
  myState?: SubmissionState;
  /** 管理視角：完成率 */
  progress?: { done: number; total: number; overdue: number };
  attachments?: number;
};

export const MANAGED_ITEMS: ManagedItem[] = [
  {
    id: "mi-014",
    title: "指導老師意願調查表",
    placement: "submission",
    summary: "填寫三個志願的指導老師順序，並簡述題目方向。整組共用一份，任一成員送出即代表全組完成。",
    publishedAt: "2026-08-11",
    dueAt: "2026-08-26",
    audience: "114 學年度學生",
    status: "published",
    schemaVersion: 2,
    myState: "draft",
    progress: { done: 5, total: 9, overdue: 0 },
    attachments: 1,
  },
  {
    id: "mi-013",
    title: "專題分組名單確認表",
    placement: "submission",
    summary: "確認五位組員名單、組長與組別類型（一般／產學）。",
    publishedAt: "2026-08-04",
    dueAt: "2026-09-04",
    audience: "114 學年度學生",
    status: "published",
    schemaVersion: 1,
    myState: "submitted",
    progress: { done: 8, total: 9, overdue: 0 },
  },
  {
    id: "mi-012",
    title: "專題題目與摘要初稿",
    placement: "requirement",
    summary: "填寫專題中英文題目、300 字摘要、預計使用技術與產學合作單位（如有）。",
    publishedAt: "2026-08-01",
    dueAt: "2026-09-18",
    audience: "114 學年度學生",
    status: "published",
    schemaVersion: 1,
    myState: "todo",
    progress: { done: 2, total: 9, overdue: 0 },
  },
  {
    id: "mi-011",
    title: "系統驗收簡報與說明文件",
    placement: "submission",
    summary: "上傳系統驗收簡報（PDF）與操作說明文件。單檔上限 100 MiB。",
    publishedAt: "2026-07-20",
    dueAt: "2026-08-15",
    audience: "114 學年度學生",
    status: "published",
    schemaVersion: 3,
    myState: "overdue",
    progress: { done: 6, total: 9, overdue: 3 },
    attachments: 2,
  },
];

/* -------------------------------------------------------------------------- */
/* 公開內容                                                                    */
/* -------------------------------------------------------------------------- */

export type NewsItem = {
  id: string;
  category: "專題事務" | "競賽資訊" | "活動" | "規則異動";
  title: string;
  summary: string;
  date: string;
  pinned?: boolean;
  attachments?: number;
  /** 暫用系網照片，上線前替換 */
  image: string;
  /** 發布對象（規格 §4.3）；未填視為公開 */
  audience?: "public" | "members" | "students" | "teachers";
};

export const NEWS: NewsItem[] = [
  {
    id: "n-31",
    image: "/placeholder/students.jpg",
    category: "專題事務",
    title: "114 學年度專題分組作業與指導老師意願調查開始受理",
    summary:
      "分組名單確認表與指導老師意願調查表已開放填寫，請各組組長於截止日前完成送出；同組任一成員送出即代表全組完成。",
    date: "2026-08-14",
    pinned: true,
    attachments: 2,
  },
  {
    id: "n-30",
    image: "/placeholder/study.jpg",
    category: "規則異動",
    title: "專題規則 2026.1 版修訂：系統驗收評分項目調整為七項",
    summary: "系統驗收評分項目由六項調整為七項，新增「資料安全與隱私處理」；權重配置同步更新。",
    date: "2026-08-12",
    attachments: 1,
  },
  {
    id: "n-29",
    image: "/placeholder/atrium.jpg",
    category: "競賽資訊",
    title: "第 31 屆全國大專校院資訊應用服務創新競賽開始報名",
    summary: "報名至 2026 年 10 月 3 日止。欲以專題作品參賽者請先與指導老師確認資格與授權範圍。",
    date: "2026-08-12",
  },
  {
    id: "n-28",
    image: "/placeholder/phone.jpg",
    category: "活動",
    title: "雲端服務實務工作坊（8/28）開放登記",
    summary: "由業界講師帶領半日實作，名額 40 人，以 114 學年度專題生優先。",
    date: "2026-08-08",
  },
  {
    id: "n-27",
    image: "/placeholder/lounge.jpg",
    audience: "students",
    category: "專題事務",
    title: "系統驗收簡報繳交期限提醒",
    summary: "尚未完成繳交之組別請儘速上傳；逾期組別需由系辦個別重新開放並填具理由。",
    date: "2026-08-05",
  },
  {
    id: "n-26",
    image: "/placeholder/present.jpg",
    category: "競賽資訊",
    title: "2026 全國智慧製造大數據分析競賽入圍名單公告",
    summary: "本系共三組作品入圍決賽，決賽日期為 9 月 2 日。",
    date: "2026-08-01",
  },
  {
    id: "n-25",
    image: "/placeholder/applause.jpg",
    category: "專題事務",
    title: "產學合作案（第二批）公開瀏覽",
    summary: "本批次共 6 件產學合作需求開放瀏覽，未指派組別者由指導老師直接認領。",
    date: "2026-07-29",
  },
];

export type IndustryItem = {
  id: string;
  company: string;
  department: string;
  title: string;
  advisorName: string;
  publishedAt: string;
  linkedGroups: number;
  /** 認領狀態：由組別關聯推導 */
  status: "open" | "claimed";
  /** 發布狀態：合作案本身（規格 §6.2） */
  publishStatus: "draft" | "public" | "unlisted";
  image?: string;
};

export const INDUSTRY: IndustryItem[] = [
  {
    id: "ind-01",
    company: "宏昇物流股份有限公司",
    department: "營運技術部",
    title: "零售門市補貨預測與缺貨警示",
    advisorName: "陳建宏",
    publishedAt: "2026-07-28",
    linkedGroups: 1,
    status: "claimed",
    publishStatus: "public",
  },
  {
    id: "ind-02",
    company: "光晨社會福利基金會",
    department: "資訊室",
    title: "捐款與收據流程數位化",
    advisorName: "王雅玲",
    publishedAt: "2026-07-28",
    linkedGroups: 1,
    status: "open",
    publishStatus: "public",
  },
  {
    id: "ind-03",
    company: "昱鋼精機工業",
    department: "智慧製造推動辦公室",
    title: "設備稼動率蒐集與可視化看板",
    advisorName: "李孟儒",
    publishedAt: "2026-07-22",
    linkedGroups: 1,
    status: "open",
    publishStatus: "public",
  },
  {
    id: "ind-04",
    company: "維禾生醫科技",
    department: "數位轉型專案辦公室",
    title: "臨床試驗文件版本控管",
    advisorName: "張士豪",
    publishedAt: "2026-07-15",
    linkedGroups: 0,
    status: "open",
    publishStatus: "public",
  },
];

export type ProjectAward = "excellent" | "merit";

export type ProjectItem = {
  id: string;
  cohort: string;
  title: string;
  field: string;
  /** excellent＝優秀專題（王冠）、merit＝佳作（獎盃）；未得獎不設 */
  award?: ProjectAward;
  /** 獎項全名，顯示在卡片與詳情 */
  awardLabel?: string;
  groupNo: string;
  advisor: string;
  summary: string;
  image: string;
  hasVideo?: boolean;
  hasPoster?: boolean;
};

export const PROJECT_AWARD_LABEL: Record<ProjectAward, string> = {
  excellent: "優秀專題",
  merit: "佳作",
};

export const PROJECTS: ProjectItem[] = [
  { id: "p-1", cohort: "113", title: "城市微光：公共資訊可讀性改善", field: "資料視覺化", award: "excellent", awardLabel: "113 學年度校級優秀專題", groupNo: "第 07 組", advisor: "王雅玲", summary: "以三個市政開放資料集為例，建立可重複套用的視覺化樣板，並以十二位非資訊背景使用者驗證閱讀效率。", image: "/placeholder/showcase.jpg", hasPoster: true, hasVideo: true },
  { id: "p-2", cohort: "113", title: "拾語：課堂討論脈絡整理器", field: "AI × 教育", award: "merit", awardLabel: "113 學年度專題發表 佳作", groupNo: "第 03 組", advisor: "陳建宏", summary: "以語音轉文字與主題聚類，把分散的課堂發言整理成可追溯的議題樹，提供教師端重點摘要。", image: "/placeholder/phone.jpg", hasPoster: true, hasVideo: true },
  { id: "p-3", cohort: "113", title: "安心路徑：校園友善空間指南", field: "服務設計", groupNo: "第 05 組", advisor: "李孟儒", summary: "實地盤點校園無障礙坡道、電梯、哺集乳室與性別友善廁所，提供路徑建議與現場照片。", image: "/placeholder/lounge.jpg", hasPoster: true },
  { id: "p-7", cohort: "113", title: "校園閒置空間共享媒合平台", field: "共享經濟", award: "merit", awardLabel: "113 學年度專題發表 佳作", groupNo: "第 09 組", advisor: "張士豪", summary: "整合各系所閒置教室與設備的借用流程，以時段媒合減少空間閒置。", image: "/placeholder/present.jpg", hasPoster: true, hasVideo: true },
  { id: "p-4", cohort: "112", title: "備援：中小企業備份稽核工具", field: "資訊安全", award: "excellent", awardLabel: "112 學年度校級優秀專題・全國賽佳作", groupNo: "第 02 組", advisor: "張士豪", summary: "自動檢查備份完整性、可還原性與保留週期，產出可交付稽核單位的報告。", image: "/placeholder/hackathon.jpg", hasPoster: true, hasVideo: true },
  { id: "p-5", cohort: "112", title: "菜市場數位帳本", field: "數位轉型", groupNo: "第 06 組", advisor: "王雅玲", summary: "以極簡輸入與語音記帳降低攤商使用門檻，實際導入三個攤位試用兩個月。", image: "/placeholder/study.jpg", hasVideo: true },
  { id: "p-6", cohort: "112", title: "無障礙報名流程重構", field: "無障礙設計", award: "merit", awardLabel: "112 學年度專題發表 佳作", groupNo: "第 11 組", advisor: "李孟儒", summary: "重新設計符合 WCAG 2.2 AA 的活動報名表單，以螢幕閱讀器與鍵盤操作完成驗證。", image: "/placeholder/atrium.jpg", hasPoster: true },
  { id: "p-8", cohort: "112", title: "跨境電商稅務試算工具", field: "金融科技", groupNo: "第 04 組", advisor: "陳建宏", summary: "整理十二國進口稅則，讓小型賣家在上架前試算落地成本。", image: "/placeholder/building.jpg", hasPoster: true },
];

export type HonorItem = {
  id: string;
  year: string;
  competition: string;
  award: string;
  team: string;
  date: string;
  image: string;
  summary: string;
};

export const HONORS: HonorItem[] = [
  { id: "h-1", year: "2026", competition: "全國大專校院資訊應用服務創新競賽", award: "優等", team: "第 04 組", date: "2026-07-07", image: "/placeholder/applause.jpg", summary: "以「備援：中小企業備份稽核工具」參賽，於資訊應用服務創新組獲優等。" },
  { id: "h-2", year: "2026", competition: "跨域設計專題成果展", award: "評審團獎", team: "第 02 組", date: "2026-06-15", image: "/placeholder/trophy.jpg", summary: "以跨系合作的服務設計作品獲評審團獎。" },
  { id: "h-3", year: "2026", competition: "校級學生專題成果競賽", award: "佳作", team: "第 11 組", date: "2026-05-20", image: "/placeholder/present.jpg", summary: "無障礙報名流程重構獲校級佳作。" },
  { id: "h-4", year: "2025", competition: "全國智慧製造大數據分析競賽", award: "第三名", team: "第 06 組", date: "2025-12-02", image: "/placeholder/atrium.jpg", summary: "以設備稼動率預測模型獲第三名。" },
  { id: "h-5", year: "2025", competition: "大專校院資訊服務創新競賽 北區賽", award: "佳作", team: "第 07 組", date: "2025-11-14", image: "/placeholder/students.jpg", summary: "城市微光原型於北區賽獲佳作。" },
  { id: "h-6", year: "2025", competition: "校級學生專題成果競賽", award: "優等", team: "第 03 組", date: "2025-05-22", image: "/placeholder/study.jpg", summary: "拾語：課堂討論脈絡整理器獲校級優等。" },
];

/* -------------------------------------------------------------------------- */
/* 成績（MOC §7）                                                              */
/* -------------------------------------------------------------------------- */

export const GRADING_SCHEME = {
  version: 2,
  locked: true,
  stages: [
    {
      id: "st-1",
      name: "系統驗收",
      weight: 60,
      items: [
        { id: "it-1", name: "需求與問題定義", max: 100, weight: 15, input: "number" as const },
        { id: "it-2", name: "系統設計與架構", max: 100, weight: 20, input: "number" as const },
        { id: "it-3", name: "實作完整度", max: 100, weight: 25, input: "number" as const },
        { id: "it-4", name: "資料安全與隱私處理", max: 100, weight: 10, input: "number" as const },
        { id: "it-5", name: "測試與品質", max: 100, weight: 10, input: "number" as const },
        { id: "it-6", name: "文件與可維護性", max: 100, weight: 10, input: "letter" as const },
        { id: "it-7", name: "簡報與答辯", max: 100, weight: 10, input: "letter" as const },
      ],
    },
    { id: "st-2", name: "專題發表", weight: 40, items: [] },
  ],
};

export const EVALUATION_QUEUE = [
  { groupId: "g-07", groupNo: "第 07 組", title: "校園閒置空間共享媒合平台", state: "pending" as const },
  { groupId: "g-02", groupNo: "第 02 組", title: "零售門市補貨預測", state: "staged" as const },
  { groupId: "g-04", groupNo: "第 04 組", title: "校內活動報名與簽到整合", state: "submitted" as const },
  { groupId: "g-08", groupNo: "第 08 組", title: "長照機構家屬溝通看板", state: "pending" as const },
];

/* -------------------------------------------------------------------------- */
/* 簽核（MOC §8）                                                              */
/* -------------------------------------------------------------------------- */

export const SIGNOFF = {
  id: "so-01",
  title: "專題成果授權同意書（2026.1 版）",
  packageVersion: 1,
  studentApprovals: [
    // 目前登入的學生（林彥廷）刻意留成「尚未同意」，這樣原型才看得到同意／不同意的實際互動
    { name: "林彥廷", approved: false },
    { name: "黃詩涵", approved: true, at: "2026-08-15 19:05" },
    { name: "吳柏諺", approved: true, at: "2026-08-16 09:41" },
    { name: "蔡育瑄", approved: true, at: "2026-08-16 21:13" },
    { name: "鄭凱文", approved: false },
  ],
  teacherApproval: { name: "陳建宏", approved: false },
};

/* -------------------------------------------------------------------------- */
/* 管理員 Dashboard 數字（MOC §3.6：不放營收／訂閱假數據）                        */
/* -------------------------------------------------------------------------- */

export const ADMIN_STATS = {
  pendingAccounts: 4,
  disabledAccounts: 2,
  groupedStudents: 44,
  ungroupedStudents: 4,
  groupExceptions: 1,
  unassignedIndustry: 3,
  storageUsedGiB: 18.4,
  storageTotalGiB: 200,
  lastBackupAt: "2026-08-17 03:00",
  lastRestoreDrillAt: "尚未執行",
};

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

/** 相對於原型的「今天」，固定為 2026-08-17，避免每次重整數字跳動。 */
export const TODAY = new Date("2026-08-17T00:00:00+08:00");

export function daysUntil(dateStr: string): number {
  const target = new Date(`${dateStr}T00:00:00+08:00`);
  return Math.round((target.getTime() - TODAY.getTime()) / 86_400_000);
}

export function formatDue(dateStr: string): string {
  const d = daysUntil(dateStr);
  if (d < 0) return `逾期 ${Math.abs(d)} 天`;
  if (d === 0) return "今天截止";
  return `剩 ${d} 天`;
}

/* ========================================================================== */
/* 詳情頁內容                                                                  */
/* 依 0715 會議紀錄 §9：公告點開為「圖片 + 文字」；榮譽與競賽為卡片、點開一張圖 */
/* 加文字；專題規則是「文件式內容、直接列出」，不做層層展開的結構。            */
/* ========================================================================== */

/** 公告內文。key 對應 NEWS 的 id。 */
export const NEWS_BODY: Record<string, string[]> = {
  "n-31": [
    "114 學年度專題分組作業與指導老師意願調查已於系統開放填寫，請各組於截止日前完成送出。",
    "分組名單確認表需由組長填入五位組員學號，五位成員各自登入確認後，組別才會正式成立。任一成員未確認前，組別維持申請中狀態，不會佔用其他組別的名額。",
    "指導老師意願調查表請填寫三個志願的順序，並簡述題目方向。一般專題的指導老師由系辦依行政程序指派；產學合作組別則由老師直接認領。",
    "兩份表單皆為整組共用一份，同組任一成員送出即代表全組完成，其餘成員的畫面會同步顯示已繳交。截止前可重新送出，系統會保留每一次送出的版本。",
  ],
  "n-30": [
    "專題規則已修訂為 2026.1 版，主要變動為系統驗收評分項目由六項調整為七項。",
    "新增項目為「資料安全與隱私處理」，占系統驗收階段權重 10%。其餘項目權重同步調整，各階段權重合計仍為 100%。",
    "本次修訂自公告日起適用於 114 學年度全體專題組別。已完成的評分不受影響；尚未開始的階段依新版方案計算。",
    "舊版規則仍保留於系統中可供查閱，版本切換不會影響既有紀錄。",
  ],
  "n-29": [
    "第 31 屆全國大專校院資訊應用服務創新競賽開放報名，報名期限至 2026 年 10 月 3 日止。",
    "欲以專題作品參賽的組別，請先與指導老師確認參賽資格與作品授權範圍。涉及產學合作案的作品，另需取得合作單位同意。",
    "競賽分組與投稿類別請參閱主辦單位公告。系上不代為報名，各組需自行於主辦單位系統完成程序。",
  ],
  "n-28": [
    "雲端服務實務工作坊將於 8 月 28 日舉行，由業界講師帶領半日實作。",
    "名額 40 人，以 114 學年度專題生優先。報名方式與地點將另行公告。",
  ],
  "n-27": [
    "系統驗收簡報與說明文件的繳交期限已於 8 月 15 日截止，尚未完成繳交的組別請儘速處理。",
    "逾期組別需由系辦個別重新開放，並填具重新開放的理由與新期限。重新開放不會刪除既有版本，歷史紀錄仍可查閱。",
  ],
  "n-26": [
    "2026 全國智慧製造大數據分析競賽入圍名單已公告，本系共三組作品入圍決賽。",
    "決賽日期為 9 月 2 日，入圍組別請與指導老師確認簡報與展示準備。",
  ],
  "n-25": [
    "本批次共 6 件產學合作需求開放瀏覽。合作單位、需求部門與專題內容為公開資訊；聯絡人、電話與地址僅負責老師與系辦可見。",
    "尚未指派組別的合作案，老師可於系統中直接認領為自己的指導組別。同時操作時僅一位老師會成功，另一位會收到明確的衝突提示。",
  ],
};

/** 專題作品詳情 */
export const PROJECT_DETAIL: Record<
  string,
  {
    abstract: string;
    advisor: string;
    members: string[];
    tech: string[];
    videoUrl?: string;
    hasPoster?: boolean;
  }
> = {
  "p-1": {
    abstract:
      "針對公部門開放資料網站的資訊可讀性問題，重新設計資料呈現流程。以三個實際的市政資料集為例，建立一套可重複套用的視覺化樣板，並邀請十二位非資訊背景使用者進行可用性測試，量測任務完成時間與理解正確率。",
    advisor: "王雅玲",
    members: ["周子瑜", "許哲瑋", "潘映璇", "簡宇軒", "邱郁婷"],
    tech: ["Next.js", "D3.js", "PostgreSQL", "使用者測試"],
    hasPoster: true,
  },
  "p-2": {
    abstract:
      "課堂討論常因發言分散而難以整理脈絡。本作品以語音轉文字與主題聚類，將討論內容整理成可追溯的議題樹，並提供教師端的重點摘要與未回應問題清單。",
    advisor: "陳建宏",
    members: ["賴威廷", "宋佳蓉", "馮柏勳", "涂雅雯", "石承翰"],
    tech: ["React", "語音辨識", "主題模型", "FastAPI"],
    videoUrl: "https://www.youtube.com/@fjuim",
    hasPoster: true,
  },
  "p-3": {
    abstract:
      "以校園實地盤點為基礎，建立友善空間資料庫，包含無障礙坡道、電梯、哺集乳室與性別友善廁所位置，並提供路徑建議與現場照片。盤點結果已回饋給校內單位。",
    advisor: "李孟儒",
    members: ["溫子謙", "范芷妍", "杜宥安", "洪思語", "莊博凱"],
    tech: ["React Native", "地圖服務", "實地盤點"],
    hasPoster: true,
  },
  "p-4": {
    abstract:
      "中小企業常無專責資訊人員，備份策略難以驗證。本作品建立一套備份稽核工具，自動檢查備份完整性、可還原性與保留週期，並產出可交付稽核單位的報告。",
    advisor: "張士豪",
    members: ["田家瑜", "阮柏毅", "曾語彤", "崔浩然", "翁苡榛"],
    tech: ["Go", "排程稽核", "報表產生"],
    hasPoster: true,
  },
  "p-5": {
    abstract:
      "傳統市場攤商多以紙本記帳。本作品以極簡輸入介面與語音記帳降低使用門檻，並提供進貨與銷售的簡易分析。實際導入三個攤位試用兩個月。",
    advisor: "王雅玲",
    members: ["巫佳蓁", "郝彥丞", "岳庭妤", "解軍豪", "麥若彤"],
    tech: ["Flutter", "SQLite", "語音輸入"],
    videoUrl: "https://www.youtube.com/@fjuim",
  },
  "p-6": {
    abstract:
      "以校內活動報名流程為對象，重新設計符合 WCAG 2.2 AA 的表單與流程，並以螢幕閱讀器與鍵盤操作完成完整驗證。",
    advisor: "李孟儒",
    members: ["柯亦辰", "宮宇薇", "潘冠霖", "尤思穎", "方品瑄"],
    tech: ["Next.js", "無障礙驗證", "使用者研究"],
    hasPoster: true,
  },
};

/**
 * 產學合作詳情。
 * 刻意把公開與私有欄位分開存放，前台只渲染 public 區塊，
 * private 區塊在訪客視角顯示為「僅負責老師與系辦可見」——
 * 這是 MOC §6.2 的欄位層級可見性，要在畫面上看得出來。
 */
export const INDUSTRY_DETAIL: Record<
  string,
  {
    publicFields: { content: string; requirement: string; note?: string };
    privateFields: { address: string; contact: string; phone: string; email: string };
  }
> = {
  "ind-01": {
    publicFields: {
      content:
        "門市補貨目前依店長經驗判斷，缺貨與滯銷同時發生。希望以歷史銷售、天氣與活動資料建立補貨建議，並在可能缺貨前提出警示。合作期間提供去識別化的三年銷售資料與兩間門市的實地訪談機會。",
      requirement:
        "具備 Python 或 SQL 基礎，對時間序列預測有興趣。需能配合每月一次的線上進度會議，並於期末提供可執行的原型與說明文件。",
      note: "可安排一次物流中心參訪。",
    },
    privateFields: {
      address: "新北市新莊區＊＊路＊＊號",
      contact: "＊經理",
      phone: "02-＊＊＊＊-＊＊＊＊",
      email: "＊＊＊@example.com",
    },
  },
  "ind-02": {
    publicFields: {
      content:
        "捐款收據目前以人工開立與寄送，年度結算時對帳耗時。希望建立線上捐款紀錄與電子收據流程，並保留紙本收據的補印能力。",
      requirement: "對非營利組織營運流程有興趣，需注意個資保護與財務資料正確性。",
    },
    privateFields: {
      address: "臺北市中山區＊＊路＊＊號",
      contact: "＊主任",
      phone: "02-＊＊＊＊-＊＊＊＊",
      email: "＊＊＊@example.org",
    },
  },
  "ind-03": {
    publicFields: {
      content:
        "產線設備稼動率目前以人工填寫日報表，資料延遲一天以上。希望蒐集設備訊號並建立即時看板，讓現場主管可掌握停機原因分布。",
      requirement: "需能到廠一至兩次了解現場。對 IoT 資料蒐集或視覺化有興趣者優先。",
      note: "廠區位於桃園，可協助安排交通。",
    },
    privateFields: {
      address: "桃園市中壢區＊＊路＊＊號",
      contact: "＊工程師",
      phone: "03-＊＊＊-＊＊＊＊",
      email: "＊＊＊@example.com",
    },
  },
  "ind-04": {
    publicFields: {
      content:
        "臨床試驗文件版本眾多，稽核時難以追溯特定版本的核准紀錄。希望建立文件版本與簽核歷程的查詢介面。",
      requirement: "需理解版本控制概念，對法規遵循文件有耐心。",
    },
    privateFields: {
      address: "新竹縣竹北市＊＊路＊＊號",
      contact: "＊專員",
      phone: "03-＊＊＊-＊＊＊＊",
      email: "＊＊＊@example.com",
    },
  },
};

/**
 * 專題規則文件。
 * 0715 會議紀錄 §9：「可自行編輯的文件式內容，直接列出、可編輯即可
 * （不做需一直點開的層層結構）」——所以這裡是平鋪的段落，不是折疊選單。
 */
export const RULES_DOC = {
  version: "2026.1",
  updatedAt: "2026-08-12",
  intro: "本規則內容依系上現行專題規則（原專題網站九節）整理，全文直接列出。",
  sections: [
    { id: "s1", heading: "一、專題課程目的", list: ["促使學生整合應用所學的知識", "提供同學由始至終發展專案的親身體驗", "促進同學對研究主題有更深一層的了解", "培養團隊合作的精神"] },
    { id: "s2", heading: "二、專題修課限制", list: ["「系統分析與設計」擋修「資訊系統專題一」。", "「資訊系統專題二」成績不及格，需重修「資訊系統專題一」及「資訊系統專題二」。"] },
    { id: "s3", heading: "三、專題題目及範圍", paragraphs: ["專題題目宜多元化，同時必須與資訊系統有所關聯，並以使用資訊科技為其主要發展工具，而其難易程度與範圍之大小可由指導老師依該組學生程度自行分配，同時必須在提出專案計畫書時確定。"] },
    { id: "s4", heading: "四、專題分組、選取指導老師", paragraphs: ["資格條件符合之同學，以組別名義報名（每組五人），抽籤決定指導老師。採公開抽籤方式選取專題指導老師，請每組至少派一員參加抽籤。"], notes: ["註一：若單獨個人或少於五人以組別名義報名，則由系上安排分組，不得有異議。", "註二：若該組無人參與抽籤，助教在宣讀該組組員人名三聲後，尚無人抽籤（他人不得代抽），視同放棄權利，遞補抽籤後之餘額，同學不得有異議。", "註三：未繳交志願表者，不得參加抽籤，並遞補抽籤後之餘額。", "註四：若老師有產學合作或其他特別計畫或使命，可優先指定組別，且不限指定組數。"] },
    { id: "s5", heading: "五、轉組", paragraphs: ["雙方指導老師同意即可，但每小組人數仍應維持五人為原則。需填具「轉組同意書」，由雙方指導老師簽名同意。"] },
    { id: "s6", heading: "六、上課方式", paragraphs: ["各組上課方式由指導老師自行決定。"] },
    { id: "s7", heading: "七、課程要求", paragraphs: ["所須呈交的書面文件或系統展示的時間如下："], list: ["第一階段－計畫書發表：於上學期結束前以計畫書發表。", "第二階段－系統驗收：於正式發表前一個月進行，繳交正式系統發展文件及系統驗收。", "第三階段－正式發表：於三下學期末前公開發表。", "繳交專題成品：三下學期末繳交專題系統光碟及文件完稿。"] },
    { id: "s8", heading: "八、評分方式", list: ["專題學期分數由專題指導老師評訂。", "第一階段－計畫書發表：評審老師提出改進建議。", "第二階段－系統驗收：評分項目包括系統文件、系統功能，佔專題發表分數 60%。", "第三階段－正式發表：評分項目包括專題發表臨場表現及系統驗收後整體系統功能修改程度，佔專題發表分數 40%。", "評分細項請參照專題發表評分標準說明。"] },
    { id: "s9", heading: "九、獎懲方式", list: ["如指導老師不同意組別或個人參加正式發表，視同專題不及格，需重修專題；如有特殊狀況，得由專題評審委員會討論之。", "優勝隊伍的評選方式是由評審推薦出優秀得獎隊伍，優等組數以 30% 為原則。", "重新發表組別的評選方式是由各組評審老師認定不及格的組別或個人，將於一個月後重新發表。", "重新發表之專題組或個人如評審分數不及格，則重修專題。", "專題作品若涉有舞弊情事，則依輔仁大學學則及考試規則處理。"] },
  ],
  attachments: [
    { name: "專題規則 2026.1 版.pdf", size: "412 KB" },
    { name: "專題發表評分標準說明.pdf", size: "96 KB" },
  ],
};

/** 檔案下載（登入後）。共用檔案服務的公開資源視圖，規格 §4.7。 */
export type FileItem = { id: string; name: string; category: string; size: string; date: string; cohort: string };

export const FILES: FileItem[] = [
  { id: "f-1", name: "專案計畫書範本 2026.docx", category: "範本與格式", size: "128 KB", date: "2026-08-01", cohort: "114" },
  { id: "f-2", name: "系統分析與設計文件格式.docx", category: "範本與格式", size: "210 KB", date: "2026-08-01", cohort: "114" },
  { id: "f-3", name: "成果海報 A1 範本.pptx", category: "範本與格式", size: "3.2 MB", date: "2026-08-05", cohort: "114" },
  { id: "f-4", name: "專題規則 2026.1 版.pdf", category: "規則與說明", size: "412 KB", date: "2026-08-12", cohort: "114" },
  { id: "f-5", name: "114 專題分組作業說明.pdf", category: "規則與說明", size: "312 KB", date: "2026-08-14", cohort: "114" },
  { id: "f-6", name: "指導老師名單與研究領域.pdf", category: "規則與說明", size: "188 KB", date: "2026-08-14", cohort: "114" },
  { id: "f-7", name: "系統驗收評分項目（七項）說明.pdf", category: "系統驗收", size: "96 KB", date: "2026-08-12", cohort: "114" },
  { id: "f-8", name: "驗收簡報格式建議.pptx", category: "系統驗收", size: "1.1 MB", date: "2026-08-20", cohort: "114" },
  { id: "f-9", name: "產學合作保密協議範本.docx", category: "產學合作", size: "76 KB", date: "2026-07-22", cohort: "114" },
  { id: "f-10", name: "113 學年度專題發表議程.pdf", category: "規則與說明", size: "240 KB", date: "2025-06-01", cohort: "113" },
];

/** 競賽資訊。0715 §9：比照公告卡片。 */
export type Competition = {
  id: string;
  title: string;
  organizer: string;
  deadline: string;
  eventDate?: string;
  /** 狀態不存欄位：由 deadline／eventDate 與今天推導（catalog.competitionStatus） */
  summary: string;
  image: string;
  link?: string;
};

export const COMPETITIONS: Competition[] = [
  {
    id: "c-1",
    image: "/placeholder/applause.jpg",
    link: "https://innoserve.tca.org.tw/",
    title: "第 31 屆全國大專校院資訊應用服務創新競賽",
    organizer: "教育部資訊及科技教育司",
    deadline: "2026-10-03",
    summary:
      "分為資訊應用服務創新、行動應用服務創新等組別。欲以專題作品參賽者，請先與指導老師確認資格與授權範圍。",
  },
  {
    id: "c-2",
    image: "/placeholder/trophy.jpg",
    title: "2026 全國智慧製造大數據分析競賽",
    organizer: "智慧製造推動聯盟",
    deadline: "2026-07-31",
    eventDate: "2026-09-02",
    summary: "本系共三組作品入圍決賽，決賽日期為 9 月 2 日。入圍組別請與指導老師確認展示準備。",
  },
  {
    id: "c-3",
    image: "/placeholder/present.jpg",
    title: "跨域設計專題成果展",
    organizer: "校內教學發展中心",
    deadline: "2026-06-20",
    eventDate: "2026-07-05",
    summary: "以跨領域合作為主題的校內成果展，本系有兩組作品獲評審推薦。",
  },
];

/* -------------------------------------------------------------------------- */
/* 後台（2026-09-08）：通知、稽核、帳號、趨勢                                     */
/* -------------------------------------------------------------------------- */

export type Notification = {
  id: string;
  kind: "due" | "submission" | "signoff" | "grading" | "account" | "system";
  title: string;
  body: string;
  at: string;
  read: boolean;
  href: string;
};

export const NOTIFICATIONS: Record<Role, Notification[]> = {
  student: [
    { id: "n-s1", kind: "due", title: "指導老師意願調查表 9 天後截止", body: "草稿尚未送出，任一組員送出即完成。", at: "08-17 09:00", read: false, href: "/dashboard/student/affairs/mi-014" },
    { id: "n-s2", kind: "signoff", title: "專題成果授權同意書等你同意", body: "已有 3 位組員同意。", at: "08-16 21:13", read: false, href: "/dashboard/student/signoff" },
    { id: "n-s3", kind: "submission", title: "專題分組名單確認表已繳交", body: "黃詩涵於 08-14 送出，版本 v1。", at: "08-14 16:20", read: true, href: "/dashboard/student/affairs/mi-013" },
    { id: "n-s4", kind: "system", title: "第 07 組還有 2 位成員未確認", body: "蔡育瑄、鄭凱文尚未確認加入。", at: "08-13 10:02", read: true, href: "/dashboard/student/groups" },
  ],
  teacher: [
    { id: "n-t1", kind: "grading", title: "系統驗收：第 07 組待評分", body: "評分表已開放，送出後鎖定。", at: "08-17 08:30", read: false, href: "/dashboard/teacher/grading/g-07" },
    { id: "n-t2", kind: "signoff", title: "第 08 組同意書等待老師同意", body: "五位學生已全數同意。", at: "08-16 22:05", read: false, href: "/dashboard/teacher/signoff" },
    { id: "n-t3", kind: "submission", title: "第 02 組送出系統驗收簡報", body: "版本 v2，附件 2 個。", at: "08-15 17:44", read: true, href: "/dashboard/teacher/affairs" },
    { id: "n-t4", kind: "system", title: "2 個產學組尚未指派老師", body: "第 03 組、第 06 組可認領。", at: "08-12 09:00", read: true, href: "/dashboard/teacher/groups" },
  ],
  admin: [
    { id: "n-a1", kind: "account", title: "4 筆帳號等待審核", body: "名單未命中或以 Email 註冊。", at: "08-17 07:50", read: false, href: "/dashboard/admin/accounts?status=pending" },
    { id: "n-a2", kind: "due", title: "系統驗收簡報：3 組逾期", body: "需個別重新開放並填理由。", at: "08-16 00:05", read: false, href: "/dashboard/admin/affairs/mi-011" },
    { id: "n-a3", kind: "grading", title: "系統驗收缺評老師 2 位", body: "李孟儒、張士豪尚未送出。", at: "08-15 18:00", read: false, href: "/dashboard/admin/grading" },
    { id: "n-a4", kind: "system", title: "每日備份完成", body: "08-17 03:00，18.4 GiB。", at: "08-17 03:02", read: true, href: "/dashboard/admin/files" },
  ],
};

export type AuditEvent = { id: string; at: string; actor: string; role: Role | "system"; action: string; target: string; reason?: string };

export const AUDIT_EVENTS: AuditEvent[] = [
  { id: "ae-01", at: "2026-08-17 09:12", actor: "系辦管理員", role: "admin", action: "重新開放收件", target: "系統驗收簡報與說明文件・第 05 組", reason: "組員住院，延至 08-22" },
  { id: "ae-02", at: "2026-08-16 22:05", actor: "陳建宏", role: "teacher", action: "認領產學組", target: "第 02 組" },
  { id: "ae-03", at: "2026-08-16 15:30", actor: "系辦管理員", role: "admin", action: "核准帳號", target: "411410455 高雅筑", reason: "名單姓名有誤字，已確認" },
  { id: "ae-04", at: "2026-08-15 18:00", actor: "王雅玲", role: "teacher", action: "送出正式評分", target: "系統驗收・第 04 組" },
  { id: "ae-05", at: "2026-08-15 10:20", actor: "系辦管理員", role: "admin", action: "發布項目", target: "指導老師意願調查表 v2" },
  { id: "ae-06", at: "2026-08-14 16:20", actor: "黃詩涵", role: "student", action: "正式繳交", target: "專題分組名單確認表・第 07 組 v1" },
  { id: "ae-07", at: "2026-08-13 09:00", actor: "系統", role: "system", action: "自動核准", target: "411410123 林彥廷（命中名單 v3）" },
  { id: "ae-08", at: "2026-08-12 14:40", actor: "系辦管理員", role: "admin", action: "建立例外組別", target: "第 09 組（4 人）", reason: "轉系生名額不足" },
];

export type Account = { id: string; name: string; studentNo?: string; email: string; role: Role; cohort: string; status: "active" | "pending" | "disabled"; createdAt: string; approvedBy?: string };

export const ACCOUNTS: Account[] = [
  { id: "a-01", name: "林彥廷", studentNo: "411410123", email: "411410123@m365.fju.edu.tw", role: "student", cohort: "114", status: "active", createdAt: "2026-08-13", approvedBy: "名單自動" },
  { id: "a-02", name: "黃詩涵", studentNo: "411410145", email: "411410145@m365.fju.edu.tw", role: "student", cohort: "114", status: "active", createdAt: "2026-08-13", approvedBy: "名單自動" },
  { id: "a-03", name: "高雅筑", studentNo: "411410455", email: "yachu.kao@gmail.com", role: "student", cohort: "114", status: "active", createdAt: "2026-08-14", approvedBy: "系辦管理員" },
  { id: "a-04", name: "許庭瑋", studentNo: "411410466", email: "tingwei@gmail.com", role: "student", cohort: "114", status: "pending", createdAt: "2026-08-16" },
  { id: "a-05", name: "陳冠宇", studentNo: "411410477", email: "411410477@m365.fju.edu.tw", role: "student", cohort: "114", status: "pending", createdAt: "2026-08-16" },
  { id: "a-06", name: "劉思妤", studentNo: "410410312", email: "siyu.liu@gmail.com", role: "student", cohort: "113", status: "pending", createdAt: "2026-08-17" },
  { id: "a-07", name: "王小明", studentNo: "411410999", email: "wang.xm@gmail.com", role: "student", cohort: "114", status: "pending", createdAt: "2026-08-17" },
  { id: "a-08", name: "陳建宏", email: "chen.ch@mail.fju.edu.tw", role: "teacher", cohort: "—", status: "active", createdAt: "2026-07-01", approvedBy: "系辦建立" },
  { id: "a-09", name: "王雅玲", email: "wang.yl@mail.fju.edu.tw", role: "teacher", cohort: "—", status: "active", createdAt: "2026-07-01", approvedBy: "系辦建立" },
  { id: "a-10", name: "李孟儒", email: "lee.mj@mail.fju.edu.tw", role: "teacher", cohort: "—", status: "active", createdAt: "2026-07-01", approvedBy: "系辦建立" },
  { id: "a-11", name: "張士豪", email: "chang.sh@mail.fju.edu.tw", role: "teacher", cohort: "—", status: "active", createdAt: "2026-07-01", approvedBy: "系辦建立" },
  { id: "a-12", name: "周子瑜", studentNo: "411410300", email: "411410300@m365.fju.edu.tw", role: "student", cohort: "114", status: "active", createdAt: "2026-08-13", approvedBy: "名單自動" },
  { id: "a-13", name: "呂承恩", studentNo: "410410250", email: "410410250@m365.fju.edu.tw", role: "student", cohort: "113", status: "disabled", createdAt: "2025-08-10", approvedBy: "名單自動" },
  { id: "a-14", name: "郭安琪", studentNo: "410410261", email: "410410261@m365.fju.edu.tw", role: "student", cohort: "113", status: "disabled", createdAt: "2025-08-10", approvedBy: "名單自動" },
];

/** 近 7 天各日正式繳交件數（管理員／老師趨勢用；真實業務量，不是營收） */
export const SUBMISSION_TREND = [
  { day: "08-11", count: 2 }, { day: "08-12", count: 4 }, { day: "08-13", count: 3 }, { day: "08-14", count: 7 },
  { day: "08-15", count: 5 }, { day: "08-16", count: 8 }, { day: "08-17", count: 3 },
];

/** 評分階段各老師進度（管理員） */
export const GRADING_PROGRESS = [
  { teacher: "陳建宏", assigned: 3, submitted: 3 },
  { teacher: "王雅玲", assigned: 3, submitted: 2 },
  { teacher: "李孟儒", assigned: 2, submitted: 0 },
  { teacher: "張士豪", assigned: 2, submitted: 1 },
];

/** 簽核各組進度（管理員／老師） */
export const SIGNOFF_PROGRESS = GROUPS.map((g, i) => ({
  groupId: g.id,
  groupNo: g.no,
  title: g.title,
  students: g.id === "g-07" ? 3 : [5, 5, 4, 5, 2, 5, 5, 0][i % 8],
  total: g.members.length,
  teacher: [true, true, false, true, false, false, false, false][i % 8] && g.id !== "g-07",
  state: (g.id === "g-07" ? "students" : [true, true, false, true, false, false, false, false][i % 8] ? "complete" : "students") as "students" | "teacher" | "complete" | "revision",
}));

/* -------------------------------------------------------------------------- */
/* 表單欄位（規格 §4.4 v1 可用元件）與各組繳交狀態                               */
/* -------------------------------------------------------------------------- */

export type FieldType =
  | "text" | "textarea" | "number" | "email" | "url"
  | "radio" | "checkbox" | "select"
  | "date" | "time"
  | "file" | "attachment"
  | "heading" | "paragraph" | "divider" | "groupinfo";

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "短文字", textarea: "長文字", number: "數字", email: "Email", url: "網址",
  radio: "單選", checkbox: "複選", select: "下拉選單",
  date: "日期", time: "時間",
  file: "檔案上傳", attachment: "下載附件",
  heading: "區段標題", paragraph: "說明文字", divider: "分隔線", groupinfo: "組別資訊（唯讀）",
};

export type FormField = {
  id: string;
  type: FieldType;
  label: string;
  help?: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  /** 附件／上傳的說明：檔名或限制 */
  meta?: string;
};

export const FORM_SCHEMAS: Record<string, FormField[]> = {
  "mi-014": [
    { id: "f1", type: "groupinfo", label: "組別資訊" },
    { id: "f2", type: "heading", label: "指導老師志願" },
    { id: "f3", type: "select", label: "第一志願", required: true, options: ["陳建宏", "王雅玲", "李孟儒", "張士豪"] },
    { id: "f4", type: "select", label: "第二志願", required: true, options: ["陳建宏", "王雅玲", "李孟儒", "張士豪"] },
    { id: "f5", type: "select", label: "第三志願", required: true, options: ["陳建宏", "王雅玲", "李孟儒", "張士豪"] },
    { id: "f6", type: "textarea", label: "題目方向", help: "100 字內簡述", required: true, placeholder: "例：校園閒置空間的共享媒合…" },
    { id: "f7", type: "radio", label: "組別類型", required: true, options: ["一般專題", "產學合作"] },
    { id: "f8", type: "attachment", label: "指導老師研究領域一覽", meta: "PDF・212 KB" },
  ],
  "mi-013": [
    { id: "f1", type: "groupinfo", label: "組別資訊" },
    { id: "f2", type: "text", label: "組長學號", required: true },
    { id: "f3", type: "radio", label: "組別類型", required: true, options: ["一般專題", "產學合作"] },
    { id: "f4", type: "checkbox", label: "確認事項", required: true, options: ["五位組員皆為本屆學生", "已閱讀專題規則第四節"] },
  ],
  "mi-012": [
    { id: "f1", type: "groupinfo", label: "組別資訊" },
    { id: "f2", type: "text", label: "中文題目", required: true },
    { id: "f3", type: "text", label: "英文題目", required: true },
    { id: "f4", type: "textarea", label: "摘要", help: "300 字內", required: true },
    { id: "f5", type: "text", label: "預計使用技術", placeholder: "例：Next.js、PostgreSQL" },
    { id: "f6", type: "text", label: "產學合作單位（如有）" },
  ],
  "mi-011": [
    { id: "f1", type: "groupinfo", label: "組別資訊" },
    { id: "f2", type: "paragraph", label: "請於截止日前上傳系統驗收簡報與操作說明文件；單檔上限 100 MiB，不接受影片。" },
    { id: "f3", type: "file", label: "系統驗收簡報", required: true, meta: "PDF・上限 100 MiB" },
    { id: "f4", type: "file", label: "操作說明文件", required: true, meta: "PDF・上限 100 MiB" },
    { id: "f5", type: "url", label: "系統展示網址", placeholder: "https://" },
    { id: "f6", type: "date", label: "希望驗收日期" },
  ],
};

export type GroupSubmission = { groupId: string; state: SubmissionState; version?: number; submittedBy?: string; at?: string };

/** 每個收件項目各組狀態；由 progress 數字推出，順序固定，畫面才穩定 */
export const GROUP_SUBMISSIONS: Record<string, GroupSubmission[]> = Object.fromEntries(
  MANAGED_ITEMS.filter((i) => i.progress).map((item) => {
    const { done, overdue } = item.progress!;
    const rows: GroupSubmission[] = GROUPS.map((g, idx) => {
      if (idx < done) return { groupId: g.id, state: "submitted", version: ((idx + done) % 2) + 1, submittedBy: g.members[idx % g.members.length].name, at: `2026-08-${String(10 + ((idx * 3) % 7)).padStart(2, "0")} ${String(9 + (idx % 10)).padStart(2, "0")}:${String((idx * 17) % 60).padStart(2, "0")}` };
      if (idx < done + overdue) return { groupId: g.id, state: "overdue" };
      return { groupId: g.id, state: idx % 2 === 0 ? "draft" : "todo" };
    });
    if (item.myState) rows[0] = { ...rows[0], groupId: "g-07", state: item.myState, ...(item.myState === "submitted" ? { version: 1, submittedBy: "黃詩涵", at: "2026-08-14 16:20" } : {}) };
    return [item.id, rows];
  }),
);

/** 學生視角：某項目的繳交版本 */
export const SUBMISSION_VERSIONS: Record<string, { version: number; by: string; at: string; schemaVersion: number; note?: string }[]> = {
  "mi-013": [{ version: 1, by: "黃詩涵", at: "2026-08-14 16:20", schemaVersion: 1 }],
  "mi-011": [
    { version: 2, by: "林彥廷", at: "2026-08-12 23:41", schemaVersion: 3, note: "補上操作說明文件" },
    { version: 1, by: "吳柏諺", at: "2026-08-10 18:02", schemaVersion: 3 },
  ],
};
