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
  status: "active",
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
  {
    id: "mi-010",
    title: "專題成果授權同意書",
    placement: "submission",
    summary: "五位組員與指導老師逐一線上同意，全程不需下載或上傳簽名檔。",
    publishedAt: "2026-07-15",
    dueAt: "2026-09-30",
    audience: "114 學年度學生",
    status: "published",
    myState: "resubmit",
    progress: { done: 3, total: 9, overdue: 0 },
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
};

export const NEWS: NewsItem[] = [
  {
    id: "n-31",
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
    category: "規則異動",
    title: "專題規則 2026.1 版修訂：系統驗收評分項目調整為七項",
    summary: "系統驗收評分項目由六項調整為七項，新增「資料安全與隱私處理」；權重配置同步更新。",
    date: "2026-08-12",
    attachments: 1,
  },
  {
    id: "n-29",
    category: "競賽資訊",
    title: "第 31 屆全國大專校院資訊應用服務創新競賽開始報名",
    summary: "報名至 2026 年 10 月 3 日止。欲以專題作品參賽者請先與指導老師確認資格與授權範圍。",
    date: "2026-08-12",
  },
  {
    id: "n-28",
    category: "活動",
    title: "雲端服務實務工作坊（8/28）開放登記",
    summary: "由業界講師帶領半日實作，名額 40 人，以 114 學年度專題生優先。",
    date: "2026-08-08",
  },
  {
    id: "n-27",
    category: "專題事務",
    title: "系統驗收簡報繳交期限提醒",
    summary: "尚未完成繳交之組別請儘速上傳；逾期組別需由系辦個別重新開放並填具理由。",
    date: "2026-08-05",
  },
  {
    id: "n-26",
    category: "競賽資訊",
    title: "2026 全國智慧製造大數據分析競賽入圍名單公告",
    summary: "本系共三組作品入圍決賽，決賽日期為 9 月 2 日。",
    date: "2026-08-01",
  },
  {
    id: "n-25",
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
  status: "open" | "claimed";
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
  },
];

export type ProjectItem = {
  id: string;
  cohort: string;
  title: string;
  field: string;
  award?: string;
  hasVideo?: boolean;
};

export const PROJECTS: ProjectItem[] = [
  { id: "p-1", cohort: "113", title: "城市微光：公共資訊可讀性改善", field: "資料視覺化", award: "校級優秀專題" },
  { id: "p-2", cohort: "113", title: "拾語：課堂討論脈絡整理器", field: "AI × 教育", hasVideo: true },
  { id: "p-3", cohort: "113", title: "安心路徑：校園友善空間指南", field: "服務設計" },
  { id: "p-4", cohort: "112", title: "備援：中小企業備份稽核工具", field: "資訊安全", award: "全國賽佳作" },
  { id: "p-5", cohort: "112", title: "菜市場數位帳本", field: "數位轉型", hasVideo: true },
  { id: "p-6", cohort: "112", title: "無障礙報名流程重構", field: "無障礙設計" },
];

export type HonorItem = {
  id: string;
  year: string;
  competition: string;
  award: string;
  team: string;
};

export const HONORS: HonorItem[] = [
  { id: "h-1", year: "2026", competition: "全國大專資訊應用服務創新競賽", award: "優選", team: "第 04 組" },
  { id: "h-2", year: "2026", competition: "跨域設計專題成果展", award: "評審推薦", team: "第 02 組" },
  { id: "h-3", year: "2025", competition: "校級學生專題成果競賽", award: "佳作", team: "第 11 組" },
  { id: "h-4", year: "2025", competition: "全國智慧製造大數據分析競賽", award: "第三名", team: "第 06 組" },
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
