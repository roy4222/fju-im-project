/**
 * 測試站示範資料的內容（票 32，#281）：照原型 `prototype/src/lib/fixtures.ts` 抄過來的假資料。
 *
 * 只放「內容」：姓名、標題、內文、日期（原型的日期，原型的「今天」是 2026-08-17）。
 * 怎麼寫進資料庫、日期怎麼平移到現在，在 `../seed-demo.mjs`。
 * 全部是虛構資料：姓名、學號、公司都是原型的示範值；Email 一律用保留網域 `@demo.invalid`（寄不出去、也登不進來）。
 */

/** 原型的「今天」（`TODAY_YMD`）。所有日期都相對它平移到種子當下。 */
export const PROTOTYPE_TODAY = '2026-08-17'

export const EMAIL_DOMAIN = 'demo.invalid'

export const COHORT = {
  code: 'DEMO-114',
  name: '示範 114 屆',
  yearEndDate: '2027-06-30',
  groupSizeMin: 4,
  groupSizeMax: 5,
}

/**
 * 票 11：剛好四個階段（原型的八段併成四段，名稱 20 字內）。
 * `description`（票 39，0011）＝原型 `Stage.summary` 的一句話說明，四段各自併原型對應幾段的說明。
 */
export const STAGES = [
  { seq: 1, name: '分組與指導老師', startDate: '2026-08-01', description: '五人一組報名，五位成員各自確認後成立；填指導老師意願調查，產學組由老師優先指定。' },
  { seq: 2, name: '題目與計畫書', startDate: '2026-09-18', description: '確定題目與範圍，上學期結束前發表計畫書；只評通過／不通過。' },
  { seq: 3, name: '系統驗收', startDate: '2027-03-01', description: '系統發展文件完稿後，正式發表前一個月驗收系統文件與系統功能。' },
  { seq: 4, name: '專題發表與成品', startDate: '2027-05-01', description: '公開發表；之後繳交系統與文件完稿，完成成果授權同意書後封存。' },
]

/** 所有示範資料的「建立者」：不能登入（停用、沒有密碼、沒有角色）。 */
export const OFFICE = { key: 'office', name: '系辦管理員（示範）', email: 'office' }

export const TEACHERS = [
  { key: 'u-102', name: '陳建宏', email: 'chen.ch' },
  { key: 'u-103', name: '王雅玲', email: 'wang.yl' },
  { key: 'u-104', name: '李孟儒', email: 'lee.mj' },
  { key: 'u-105', name: '張士豪', email: 'chang.sh' },
]

function members(base, names) {
  return names.map((name, i) => ({ key: `u-${base + i}`, name, studentNo: `411410${base + i}` }))
}

/**
 * 組別（原型 `GROUPS`；第 07 組是原型學生本人那組）。
 * 原型把第 07 組畫成「申請中」、第 09 組畫成例外組；正式碼沒有例外組，第 09 組就是一個 4 人組（屆別每組 4–5 人）。
 * 「申請中」改由還沒分組的四位同學的一份進行中提案呈現（見 `PROPOSAL`）。
 */
export const GROUPS = [
  {
    key: 'g-07',
    code: 'G07',
    title: '校園閒置空間共享媒合平台',
    titleEn: 'Campus Idle Space Sharing Platform',
    type: 'general',
    advisor: 'u-102',
    established: '2026-08-09',
    members: [
      { key: 'u-401', name: '林彥廷', studentNo: '411410123' },
      { key: 'u-402', name: '黃詩涵', studentNo: '411410145' },
      { key: 'u-403', name: '吳柏諺', studentNo: '411410167' },
      { key: 'u-404', name: '蔡育瑄', studentNo: '411410189' },
      { key: 'u-405', name: '鄭凱文', studentNo: '411410201' },
    ],
    tech: 'Next.js、PostgreSQL',
  },
  {
    key: 'g-01',
    code: 'G01',
    title: '醫療院所排班最佳化系統',
    titleEn: 'Clinic Shift Scheduling Optimizer',
    type: 'general',
    advisor: 'u-103',
    established: '2026-08-08',
    members: members(300, ['周子瑜', '許哲瑋', '潘映璇', '簡宇軒', '邱郁婷']),
    tech: 'Python、OR-Tools、React',
  },
  {
    key: 'g-02',
    code: 'G02',
    title: '零售門市補貨預測（產學：宏昇物流）',
    titleEn: 'Retail Replenishment Forecasting',
    type: 'industry',
    advisor: 'u-102',
    advisorClaim: true,
    industry: 'ind-01',
    established: '2026-08-09',
    members: members(310, ['賴威廷', '宋佳蓉', '馮柏勳', '涂雅雯', '石承翰']),
    tech: 'Python、時間序列、Power BI',
  },
  {
    key: 'g-03',
    code: 'G03',
    title: '非營利組織捐款流程數位化（產學：光晨社福）',
    titleEn: 'Digital Donation Workflow for NPOs',
    type: 'industry',
    advisor: null,
    industry: 'ind-02',
    established: '2026-08-09',
    members: members(320, ['方品瑄', '游承翰', '廖珮綺', '康柏融', '詹于萱']),
    tech: 'Laravel、MySQL',
  },
  {
    key: 'g-04',
    code: 'G04',
    title: '校內活動報名與簽到整合',
    titleEn: 'Campus Event Registration and Check-in',
    type: 'general',
    advisor: 'u-104',
    established: '2026-08-08',
    members: members(330, ['溫子謙', '范芷妍', '杜宥安', '洪思語', '莊博凱']),
    tech: 'Flutter、Firebase',
  },
  {
    key: 'g-05',
    code: 'G05',
    title: '二手教科書交易平台',
    titleEn: 'Second-hand Textbook Marketplace',
    type: 'general',
    advisor: 'u-105',
    established: '2026-08-09',
    members: members(340, ['田家瑜', '阮柏毅', '曾語彤', '崔浩然', '翁苡榛']),
    tech: 'Vue、Node.js',
  },
  {
    key: 'g-06',
    code: 'G06',
    title: '工廠設備稼動率可視化（產學：昱鋼精機）',
    titleEn: 'Factory Equipment Utilization Dashboard',
    type: 'industry',
    advisor: null,
    industry: 'ind-03',
    established: '2026-08-09',
    members: members(350, ['何昀諠', '商柏睿', '藍怡萱', '傅子齊', '涂宥辰']),
    tech: 'MQTT、Grafana',
  },
  {
    key: 'g-08',
    code: 'G08',
    title: '長照機構家屬溝通看板',
    titleEn: 'Long-term Care Family Board',
    type: 'general',
    advisor: 'u-103',
    established: '2026-08-08',
    members: members(370, ['巫佳蓁', '郝彥丞', '岳庭妤', '解軍豪', '麥若彤']),
    tech: 'React、Supabase',
  },
  {
    key: 'g-09',
    code: 'G09',
    title: '跨境電商稅務試算工具',
    titleEn: 'Cross-border E-commerce Tax Calculator',
    type: 'general',
    advisor: null,
    established: '2026-08-09',
    members: members(380, ['柯亦辰', '宮宇薇', '潘冠霖', '尤思穎']),
    tech: 'Django、PostgreSQL',
  },
]

/** 還沒分組的同學（原型 `UNGROUPED`）。 */
export const UNGROUPED = [
  { key: 'u-501', name: '應宥丞', studentNo: '411410411', openToJoin: true },
  { key: 'u-502', name: '解雨萱', studentNo: '411410422', openToJoin: true },
  { key: 'u-503', name: '鞠柏宇', studentNo: '411410433', openToJoin: false },
  { key: 'u-504', name: '冷佳霓', studentNo: '411410444', openToJoin: true },
]

/** 進行中的組別提案：應宥丞發起，兩人已確認、兩人還沒回覆（原型「還差 2 人確認」）。 */
export const PROPOSAL = {
  proposer: 'u-501',
  created: '2026-08-16',
  confirmed: ['u-501', 'u-502'],
  pending: ['u-504', 'u-503'],
}

/** 待審核的註冊申請（原型 `ACCOUNTS` 的 pending 四筆）。 */
export const PENDING = [
  { key: 'a-04', name: '許庭瑋', studentNo: '411410466', created: '2026-08-16', rosterName: '許廷瑋' },
  { key: 'a-05', name: '陳冠宇', studentNo: '411410477', created: '2026-08-16' },
  { key: 'a-06', name: '劉思妤', studentNo: '410410312', created: '2026-08-17' },
  { key: 'a-07', name: '王小明', studentNo: '411410999', created: '2026-08-17' },
]

/** 已停用的學生（原型 `ACCOUNTS` 的 disabled 兩筆）。 */
export const DISABLED = [
  { key: 'a-13', name: '呂承恩', studentNo: '410410250' },
  { key: 'a-14', name: '郭安琪', studentNo: '410410261' },
]

/** 產學合作案（原型 `INDUSTRY`＋`INDUSTRY_DETAIL`）。私密欄位照原型打星號。 */
export const INDUSTRY = [
  {
    key: 'ind-01',
    owner: 'u-102',
    company: '宏昇物流股份有限公司',
    department: '營運技術部',
    published: '2026-07-28',
    content:
      '門市補貨目前依店長經驗判斷，缺貨與滯銷同時發生。希望以歷史銷售、天氣與活動資料建立補貨建議，並在可能缺貨前提出警示。合作期間提供去識別化的三年銷售資料與兩間門市的實地訪談機會。',
    requirements:
      '具備 Python 或 SQL 基礎，對時間序列預測有興趣。需能配合每月一次的線上進度會議，並於期末提供可執行的原型與說明文件。',
    notes: '可安排一次物流中心參訪。',
    address: '新北市新莊區＊＊路＊＊號',
    contact: '＊經理',
    phone: '02-＊＊＊＊-＊＊＊＊',
    email: '＊＊＊@example.com',
  },
  {
    key: 'ind-02',
    owner: 'u-103',
    company: '光晨社會福利基金會',
    department: '資訊室',
    published: '2026-07-28',
    content: '捐款收據目前以人工開立與寄送，年度結算時對帳耗時。希望建立線上捐款紀錄與電子收據流程，並保留紙本收據的補印能力。',
    requirements: '對非營利組織營運流程有興趣，需注意個資保護與財務資料正確性。',
    notes: null,
    address: '臺北市中山區＊＊路＊＊號',
    contact: '＊主任',
    phone: '02-＊＊＊＊-＊＊＊＊',
    email: '＊＊＊@example.org',
  },
  {
    key: 'ind-03',
    owner: 'u-104',
    company: '昱鋼精機工業',
    department: '智慧製造推動辦公室',
    published: '2026-07-22',
    content: '產線設備稼動率目前以人工填寫日報表，資料延遲一天以上。希望蒐集設備訊號並建立即時看板，讓現場主管可掌握停機原因分布。',
    requirements: '需能到廠一至兩次了解現場。對 IoT 資料蒐集或視覺化有興趣者優先。',
    notes: '廠區位於桃園，可協助安排交通。',
    address: '桃園市中壢區＊＊路＊＊號',
    contact: '＊工程師',
    phone: '03-＊＊＊-＊＊＊＊',
    email: '＊＊＊@example.com',
  },
  {
    key: 'ind-04',
    owner: 'u-105',
    company: '維禾生醫科技',
    department: '數位轉型專案辦公室',
    published: '2026-07-15',
    content: '臨床試驗文件版本眾多，稽核時難以追溯特定版本的核准紀錄。希望建立文件版本與簽核歷程的查詢介面。',
    requirements: '需理解版本控制概念，對法規遵循文件有耐心。',
    notes: null,
    address: '新竹縣竹北市＊＊路＊＊號',
    contact: '＊專員',
    phone: '03-＊＊＊-＊＊＊＊',
    email: '＊＊＊@example.com',
  },
]

/** 最新公告（原型 `NEWS`＋`NEWS_BODY`）。`attachments` 是附件檔名（示範 PDF）。 */
export const NEWS = [
  {
    key: 'n-31',
    image: 'students.jpg',
    category: '專題事務',
    title: '114 學年度專題分組作業與指導老師意願調查開始受理',
    summary: '分組名單確認表與指導老師意願調查表已開放填寫，請各組組長於截止日前完成送出；同組任一成員送出即代表全組完成。',
    date: '2026-08-14',
    attachments: ['114 專題分組作業說明.pdf', '指導老師名單與研究領域.pdf'],
    body: [
      '114 學年度專題分組作業與指導老師意願調查已於系統開放填寫，請各組於截止日前完成送出。',
      '分組名單確認表需由組長填入五位組員學號，五位成員各自登入確認後，組別才會正式成立。任一成員未確認前，組別維持申請中狀態，不會佔用其他組別的名額。',
      '指導老師意願調查表請填寫三個志願的順序，並簡述題目方向。一般專題的指導老師由系辦依行政程序指派；產學合作組別則由老師直接認領。',
      '兩份表單皆為整組共用一份，同組任一成員送出即代表全組完成，其餘成員的畫面會同步顯示已繳交。截止前可重新送出，系統會保留每一次送出的版本。',
    ],
  },
  {
    key: 'n-30',
    image: 'study.jpg',
    category: '規則異動',
    title: '專題規則修訂：系統驗收評分項目調整為七項',
    summary: '系統驗收評分項目由六項調整為七項，新增「資料安全與隱私處理」；權重配置同步更新。',
    date: '2026-08-12',
    attachments: ['系統驗收評分項目（七項）說明.pdf'],
    body: [
      '專題規則已修訂，主要變動為系統驗收評分項目由六項調整為七項。',
      '新增項目為「資料安全與隱私處理」，占系統驗收階段權重 10%。其餘項目權重同步調整，各階段權重合計仍為 100%。',
      '本次修訂自公告日起適用於 114 學年度全體專題組別。已完成的評分不受影響；尚未開始的階段依修訂後的方案計算。',
      '舊版規則仍保留於系統中可供查閱，版本切換不會影響既有紀錄。',
    ],
  },
  {
    key: 'n-29',
    image: 'atrium.jpg',
    category: '競賽資訊',
    // 票 39：原型 c-1 的報名截止（沒有活動日）；跟公告同一條時間線平移。
    registrationDeadline: '2026-10-03',
    title: '第 31 屆全國大專校院資訊應用服務創新競賽開始報名',
    summary: '報名至 2026 年 10 月 3 日止。欲以專題作品參賽者請先與指導老師確認資格與授權範圍。',
    date: '2026-08-12',
    body: [
      '第 31 屆全國大專校院資訊應用服務創新競賽開放報名，報名期限至 2026 年 10 月 3 日止。',
      '欲以專題作品參賽的組別，請先與指導老師確認參賽資格與作品授權範圍。涉及產學合作案的作品，另需取得合作單位同意。',
      '競賽分組與投稿類別請參閱主辦單位公告。系上不代為報名，各組需自行於主辦單位系統完成程序。',
    ],
  },
  {
    key: 'n-28',
    image: 'phone.jpg',
    category: '活動',
    title: '雲端服務實務工作坊（8/28）開放登記',
    summary: '由業界講師帶領半日實作，名額 40 人，以 114 學年度專題生優先。',
    date: '2026-08-08',
    body: ['雲端服務實務工作坊將於 8 月 28 日舉行，由業界講師帶領半日實作。', '名額 40 人，以 114 學年度專題生優先。報名方式與地點將另行公告。'],
  },
  {
    key: 'n-27',
    image: 'lounge.jpg',
    audience: 'cohort_students',
    category: '專題事務',
    title: '說明會出席與分組意向登記期限提醒',
    summary: '尚未完成登記之組別請儘速送出；逾期組別需由系辦個別重新開放並填具理由。',
    date: '2026-08-05',
    body: [
      '系統驗收簡報與說明文件的繳交期限已於 8 月 15 日截止，尚未完成繳交的組別請儘速處理。',
      '逾期組別需由系辦個別重新開放，並填具重新開放的理由與新期限。重新開放不會刪除既有版本，歷史紀錄仍可查閱。',
    ],
  },
  {
    key: 'n-26',
    image: 'present.jpg',
    category: '競賽資訊',
    // 票 39：原型 c-2 的報名截止與決賽日。
    registrationDeadline: '2026-07-31',
    eventDate: '2026-09-02',
    title: '2026 全國智慧製造大數據分析競賽入圍名單公告',
    summary: '本系共三組作品入圍決賽，決賽日期為 9 月 2 日。',
    date: '2026-08-01',
    body: ['2026 全國智慧製造大數據分析競賽入圍名單已公告，本系共三組作品入圍決賽。', '決賽日期為 9 月 2 日，入圍組別請與指導老師確認簡報與展示準備。'],
  },
  {
    key: 'n-25',
    image: 'applause.jpg',
    category: '專題事務',
    title: '產學合作案（第二批）公開瀏覽',
    summary: '本批次共 6 件產學合作需求開放瀏覽，未指派組別者由指導老師直接認領。',
    date: '2026-07-29',
    body: [
      '本批次共 6 件產學合作需求開放瀏覽。合作單位、需求部門與專題內容為公開資訊；聯絡人、電話與地址僅負責老師與系辦可見。',
      '尚未指派組別的合作案，老師可於系統中直接認領為自己的指導組別。同時操作時僅一位老師會成功，另一位會收到明確的衝突提示。',
    ],
  },
]

/** 專題規則（原型 `RULES_DOC`）：一節一個項目，照順序發布。 */
export const RULES = {
  date: '2026-08-12',
  sections: [
    { key: 's1', heading: '一、專題課程目的', list: ['促使學生整合應用所學的知識', '提供同學由始至終發展專案的親身體驗', '促進同學對研究主題有更深一層的了解', '培養團隊合作的精神'] },
    { key: 's2', heading: '二、專題修課限制', list: ['「系統分析與設計」擋修「資訊系統專題一」。', '「資訊系統專題二」成績不及格，需重修「資訊系統專題一」及「資訊系統專題二」。'] },
    { key: 's3', heading: '三、專題題目及範圍', paragraphs: ['專題題目宜多元化，同時必須與資訊系統有所關聯，並以使用資訊科技為其主要發展工具，而其難易程度與範圍之大小可由指導老師依該組學生程度自行分配，同時必須在提出專案計畫書時確定。'] },
    {
      key: 's4',
      heading: '四、專題分組、選取指導老師',
      paragraphs: ['資格條件符合之同學，以組別名義報名（每組五人），抽籤決定指導老師。採公開抽籤方式選取專題指導老師，請每組至少派一員參加抽籤。'],
      notes: [
        '註一：若單獨個人或少於五人以組別名義報名，則由系上安排分組，不得有異議。',
        '註二：若該組無人參與抽籤，助教在宣讀該組組員人名三聲後，尚無人抽籤（他人不得代抽），視同放棄權利，遞補抽籤後之餘額，同學不得有異議。',
        '註三：未繳交志願表者，不得參加抽籤，並遞補抽籤後之餘額。',
        '註四：若老師有產學合作或其他特別計畫或使命，可優先指定組別，且不限指定組數。',
      ],
    },
    { key: 's5', heading: '五、轉組', paragraphs: ['雙方指導老師同意即可，但每小組人數仍應維持五人為原則。需填具「轉組同意書」，由雙方指導老師簽名同意。'] },
    { key: 's6', heading: '六、上課方式', paragraphs: ['各組上課方式由指導老師自行決定。'] },
    {
      key: 's7',
      heading: '七、課程要求',
      paragraphs: ['所須呈交的書面文件或系統展示的時間如下：'],
      list: ['第一階段－計畫書發表：於上學期結束前以計畫書發表。', '第二階段－系統驗收：於正式發表前一個月進行，繳交正式系統發展文件及系統驗收。', '第三階段－正式發表：於三下學期末前公開發表。', '繳交專題成品：三下學期末繳交專題系統光碟及文件完稿。'],
    },
    {
      key: 's8',
      heading: '八、評分方式',
      list: ['專題學期分數由專題指導老師評訂。', '第一階段－計畫書發表：評審老師提出改進建議。', '第二階段－系統驗收：評分項目包括系統文件、系統功能，佔專題發表分數 60%。', '第三階段－正式發表：評分項目包括專題發表臨場表現及系統驗收後整體系統功能修改程度，佔專題發表分數 40%。', '評分細項請參照專題發表評分標準說明。'],
    },
    {
      key: 's9',
      heading: '九、獎懲方式',
      list: [
        '如指導老師不同意組別或個人參加正式發表，視同專題不及格，需重修專題；如有特殊狀況，得由專題評審委員會討論之。',
        '優勝隊伍的評選方式是由評審推薦出優秀得獎隊伍，優等組數以 30% 為原則。',
        '重新發表組別的評選方式是由各組評審老師認定不及格的組別或個人，將於一個月後重新發表。',
        '重新發表之專題組或個人如評審分數不及格，則重修專題。',
        '專題作品若涉有舞弊情事，則依輔仁大學學則及考試規則處理。',
      ],
    },
  ],
}

/**
 * 檔案下載（原型 `FILES`＋專題事務的「指導老師研究領域一覽」）。一份資源一個項目，附一個示範 PDF。
 * 原型有 .docx／.pptx；這裡一律附同名的示範 PDF（內容只寫「示範檔案」），不假裝是真的範本。
 */
export const RESOURCES = [
  { key: 'mi-028', title: '指導老師研究領域一覽', category: '規則與說明', date: '2026-08-11', audience: 'cohort_students', summary: '四位老師的研究領域與近年指導題目，填意願前先看。' },
  { key: 'f-1', title: '專案計畫書範本 2026', category: '範本與格式', date: '2026-08-01' },
  { key: 'f-2', title: '系統分析與設計文件格式', category: '範本與格式', date: '2026-08-01' },
  { key: 'f-3', title: '成果海報 A1 範本', category: '範本與格式', date: '2026-08-05' },
  { key: 'f-4', title: '專題規則', category: '規則與說明', date: '2026-08-12' },
  { key: 'f-5', title: '114 專題分組作業說明', category: '規則與說明', date: '2026-08-14' },
  { key: 'f-6', title: '指導老師名單與研究領域', category: '規則與說明', date: '2026-08-14' },
  { key: 'f-7', title: '系統驗收評分項目（七項）說明', category: '系統驗收', date: '2026-08-12' },
  { key: 'f-8', title: '驗收簡報格式建議', category: '系統驗收', date: '2026-08-15' },
  { key: 'f-9', title: '產學合作保密協議範本', category: '產學合作', date: '2026-07-22' },
  { key: 'f-10', title: '113 學年度專題發表議程', category: '規則與說明', date: '2025-06-01' },
]

const TEACHER_NAMES = ['陳建宏', '王雅玲', '李孟儒', '張士豪']
const GROUP_TYPES = ['一般專題', '產學合作']

/**
 * 收件項目（原型 `MANAGED_ITEMS` 的四個收件＋`FORM_SCHEMAS`）。欄位只用正式碼有的型態：
 * 原型的「組別資訊（唯讀）」「下載附件」兩種正式碼沒有，拿掉；附件改成項目附件。
 * `progress`、`mine`＝原型的完成數與第 07 組的狀態，種子照原型 `GROUP_SUBMISSIONS` 的算法排出各組狀態。
 */
export const COLLECTIONS = [
  {
    key: 'mi-014',
    title: '指導老師意願調查表',
    placement: 'submission',
    summary: '填寫三個志願的指導老師順序，並簡述題目方向。整組一份，組別成立後由任一組員送出。',
    published: '2026-08-11',
    due: '2026-08-26',
    stage: 1,
    attachments: ['指導老師研究領域一覽.pdf'],
    progress: { done: 5, overdue: 0 },
    mine: 'draft',
    fields: [
      { key: 'f2', type: 'heading', label: '指導老師志願' },
      { key: 'f3', type: 'select', label: '第一志願', required: true, options: TEACHER_NAMES },
      { key: 'f4', type: 'select', label: '第二志願', required: true, options: TEACHER_NAMES },
      { key: 'f5', type: 'select', label: '第三志願', required: true, options: TEACHER_NAMES },
      { key: 'f6', type: 'textarea', label: '題目方向', help: '100 字內簡述', required: true },
      { key: 'f7', type: 'radio', label: '組別類型', required: true, options: GROUP_TYPES },
    ],
  },
  {
    key: 'mi-013',
    title: '專題分組名單確認表',
    placement: 'submission',
    summary: '確認五位組員名單、組長與組別類型（一般／產學）。',
    published: '2026-08-04',
    due: '2026-09-04',
    stage: 1,
    progress: { done: 8, overdue: 0 },
    mine: 'submitted',
    mineVersions: [{ by: 'u-402', at: '2026-08-14 16:20' }],
    fields: [
      { key: 'f2', type: 'text', label: '組長學號', required: true },
      { key: 'f3', type: 'radio', label: '組別類型', required: true, options: GROUP_TYPES },
      { key: 'f4', type: 'checkbox', label: '確認事項', required: true, options: ['五位組員皆為本屆學生', '已閱讀專題規則第四節'] },
    ],
  },
  {
    key: 'mi-012',
    title: '專題題目與摘要初稿',
    placement: 'requirement',
    summary: '填寫專題中英文題目、300 字摘要、預計使用技術與產學合作單位（如有）。',
    published: '2026-08-01',
    due: '2026-09-18',
    stage: 2,
    progress: { done: 2, overdue: 0 },
    mine: 'todo',
    fields: [
      { key: 'f2', type: 'text', label: '中文題目', required: true },
      { key: 'f3', type: 'text', label: '英文題目', required: true },
      { key: 'f4', type: 'textarea', label: '摘要', help: '300 字內', required: true },
      { key: 'f5', type: 'text', label: '預計使用技術' },
      { key: 'f6', type: 'text', label: '產學合作單位（如有）' },
    ],
  },
  {
    key: 'mi-011',
    title: '專題說明會出席與分組意向登記',
    placement: 'submission',
    summary: '登記 8/20 說明會出席人數，並填暫定組員名單與意向（一般／產學）。整組一份，截止後唯讀。',
    published: '2026-07-20',
    due: '2026-08-15',
    stage: 1,
    attachments: ['114 專題分組作業說明.pdf'],
    progress: { done: 6, overdue: 3 },
    mine: 'locked',
    mineVersions: [
      { by: 'u-403', at: '2026-08-10 18:02' },
      { by: 'u-401', at: '2026-08-12 23:41' },
    ],
    fields: [
      { key: 'f2', type: 'paragraph', label: '8/20 專題說明會請至少一位組員出席；暫定組員之後仍可在「分組名單確認表」調整。' },
      { key: 'f3', type: 'number', label: '出席人數', required: true },
      { key: 'f4', type: 'textarea', label: '暫定組員（姓名、學號）', required: true },
      { key: 'f5', type: 'radio', label: '意向', required: true, options: GROUP_TYPES },
      { key: 'f6', type: 'url', label: '先前作品或提案連結' },
    ],
  },
]

/** 活動（原型 `CALENDAR_EVENTS` 的活動與競賽；截止日由收件項目自己帶出來）。 */
export const EVENTS = [
  { key: 'c2', title: '114 學年度專題說明會', date: '2026-08-20', from: '13:10', to: '15:00', audience: 'public', description: '說明本學年度專題時程、分組方式與評分規則。' },
  { key: 'c4', title: '雲端服務實務工作坊', date: '2026-08-28', from: '09:00', to: '12:00', audience: 'cohort_students', description: '業界講師帶領半日實作，名額 40 人。' },
  { key: 'c6', title: '全國大專資訊應用服務創新競賽報名截止', date: '2026-09-11', allDay: true, audience: 'public' },
  { key: 'c8', title: '指導老師公開抽籤', date: '2026-09-25', from: '15:00', to: '16:00', audience: 'cohort_students', description: '每組至少派一員參加。' },
  { key: 'c9', title: '智慧製造大數據分析競賽決賽', date: '2026-10-02', allDay: true, audience: 'public' },
]

/**
 * 評分方案（原型 `GRADING_SCHEME`）。原型的「專題發表」沒有項目，正式碼的方案每階段至少一個項目，
 * 補兩項（照規則第八節：臨場表現、驗收後修改程度）。
 */
export const GRADING = {
  name: '114 學年度專題評分方案',
  stages: [
    {
      key: 's1',
      name: '系統驗收',
      weight: 60,
      letterMap: { A: 95, B: 85, C: 75, D: 65, F: 50 },
      items: [
        { key: 'i1', name: '需求與問題定義', type: 'number', max: 100, weight: 15 },
        { key: 'i2', name: '系統設計與架構', type: 'number', max: 100, weight: 20 },
        { key: 'i3', name: '實作完整度', type: 'number', max: 100, weight: 25 },
        { key: 'i4', name: '資料安全與隱私處理', type: 'number', max: 100, weight: 10 },
        { key: 'i5', name: '測試與品質', type: 'number', max: 100, weight: 10 },
        { key: 'i6', name: '文件與可維護性', type: 'letter', max: null, weight: 10 },
        { key: 'i7', name: '簡報與答辯', type: 'letter', max: null, weight: 10 },
      ],
    },
    {
      key: 's2',
      name: '專題發表',
      weight: 40,
      letterMap: null,
      items: [
        { key: 'i8', name: '發表臨場表現', type: 'number', max: 100, weight: 60 },
        { key: 'i9', name: '驗收後整體修改程度', type: 'number', max: 100, weight: 40 },
      ],
    },
  ],
  /**
   * 系統驗收的評分指派（原型 `GRADING_PROGRESS`＋`EVALUATION_QUEUE`：陳建宏 4 組送出 1、王雅玲 3/3、李孟儒 2/0、張士豪 2/2）。
   * `state`：none＝還沒填、draft＝暫存、final＝正式送出（採計）。
   */
  assignments: [
    { teacher: 'u-102', group: 'g-07', state: 'none' },
    { teacher: 'u-102', group: 'g-02', state: 'draft', at: '2026-08-16 20:10', scores: { i1: '82', i2: '78' } },
    { teacher: 'u-102', group: 'g-04', state: 'final', at: '2026-08-15 16:40', scores: { i1: '88', i2: '85', i3: '90', i4: '80', i5: '84', i6: 'A', i7: 'B' } },
    { teacher: 'u-102', group: 'g-08', state: 'none' },
    { teacher: 'u-103', group: 'g-01', state: 'final', at: '2026-08-14 11:05', scores: { i1: '90', i2: '88', i3: '86', i4: '85', i5: '88', i6: 'A', i7: 'A' } },
    { teacher: 'u-103', group: 'g-04', state: 'final', at: '2026-08-15 18:00', scores: { i1: '84', i2: '82', i3: '87', i4: '78', i5: '80', i6: 'B', i7: 'A' } },
    { teacher: 'u-103', group: 'g-08', state: 'final', at: '2026-08-15 18:20', scores: { i1: '80', i2: '79', i3: '83', i4: '76', i5: '81', i6: 'B', i7: 'B' } },
    { teacher: 'u-104', group: 'g-01', state: 'none' },
    { teacher: 'u-104', group: 'g-05', state: 'none' },
    { teacher: 'u-105', group: 'g-02', state: 'final', at: '2026-08-16 10:30', scores: { i1: '86', i2: '84', i3: '88', i4: '82', i5: '85', i6: 'A', i7: 'B' } },
    { teacher: 'u-105', group: 'g-05', state: 'final', at: '2026-08-16 14:15', scores: { i1: '78', i2: '80', i3: '76', i4: '74', i5: '79', i6: 'C', i7: 'B' } },
  ],
  assignedAt: '2026-08-10',
  requiredCount: 2,
}

/**
 * 簽核（原型 `SIGNOFF`＋`SIGNOFF_SEED`）：專題成果授權同意書＝最終文件授權。
 * 只有有主指導的組建得出簽核版本（第 03、06、09 組還沒有主指導，不建）。
 * `approvals`：哪幾位學生已同意（數字＝照學號順序前 n 位）、主指導同意了沒；版本狀態由它推出來
 * （學生沒同意齊＝收集學生同意中、學生齊了＝等待指導老師、老師也同意＝已完成），跟逐人同意一致。
 * 第 07 組照原型：黃詩涵、吳柏諺、蔡育瑄已同意，林彥廷、鄭凱文還沒。
 */
export const SIGNOFF = {
  title: '專題成果授權同意書',
  created: '2026-08-15',
  body: [
    '本組同意將本學年度專題成果（題目、摘要、海報與展示影片連結）授權輔仁大學資訊管理學系，於系網「優秀專題」與成果展示等非營利用途公開。',
    '授權範圍以下方列出的題目與摘要為準；之後若修改內容，需重新建立簽核版本並重新同意。',
    '涉及產學合作案的作品，公開前另需取得合作單位同意。',
  ],
  approvals: {
    'g-07': {
      students: [
        { key: 'u-402', at: '2026-08-15 19:05' },
        { key: 'u-403', at: '2026-08-16 09:41' },
        { key: 'u-404', at: '2026-08-16 21:13' },
      ],
      teacher: null,
    },
    'g-01': { students: 5, teacher: '2026-08-16 20:30' },
    'g-02': { students: 5, teacher: null },
    'g-04': { students: 5, teacher: '2026-08-16 18:10' },
    'g-05': { students: 2, teacher: null },
    'g-08': { students: 5, teacher: '2026-08-16 22:05' },
  },
}

/** 各組精選草稿的摘要（題目用組別題目）。 */
export const SHOWCASE_SUMMARY = {
  'g-07': '整合各系所閒置教室與設備的借用流程，以時段媒合減少空間閒置，並提供借用紀錄查詢。',
  'g-01': '以排班限制條件建模，自動產生符合人力需求與休假規則的班表，減少人工排班時間。',
  'g-02': '以歷史銷售、天氣與活動資料建立門市補貨建議，並在可能缺貨前提出警示。',
  'g-03': '建立線上捐款紀錄與電子收據流程，縮短年度結算的對帳時間。',
  'g-04': '整合校內活動報名、候補與現場 QR Code 簽到，活動結束自動產出出席統計。',
  'g-05': '提供校內二手教科書刊登、議價與面交時段安排，降低學生購書成本。',
  'g-06': '蒐集設備訊號建立即時稼動率看板，讓現場主管掌握停機原因分布。',
  'g-08': '讓長照機構以看板即時分享住民日常與活動照片，減少家屬電話詢問。',
  'g-09': '整理多國進口稅則，讓小型賣家在上架前試算落地成本。',
}

// ── 第二批（票 32 追加，#293 前台補六頁用）：歷屆專題、榮譽榜、競賽 ─────────────────────────
// 這一批是「歷史」：日期照原型原樣、不平移（平移會把 2025-12 的榮譽推進 2026，打亂年份篩選）。
// 唯一例外是補上的那則競賽公告，它跟第一批的公告同一條時間線，照第一批的平移天數。

/** 歷屆的兩個示範屆別（已封存）。代碼帶 DEMO-，不會跟測試站真的屆別撞。學號前綴避開第一批的學號。 */
export const HISTORY_COHORTS = [
  { key: 'DEMO-113', code: 'DEMO-113', name: '示範 113 屆', yearEndDate: '2026-06-30', created: '2025-07-01', studentPrefix: '4104105' },
  { key: 'DEMO-112', code: 'DEMO-112', name: '示範 112 屆', yearEndDate: '2025-06-30', created: '2024-07-01', studentPrefix: '4094105' },
]

/**
 * 歷屆專題（原型 `PROJECTS`＋`PROJECT_DETAIL`）：一件一組、一個已發布的精選條目（海報＝原型的卡片圖）。
 * 組員只有原型詳情有列的幾件才有（p-7、p-8 原型沒有組員名單）；主指導照原型。
 * 八件都發布（歷屆一覽）；`award`／`awardLabel` 照原型（票 39，0011 的 `showcase_entries.award_level`／`award_label`）：
 * 有等級的五件才出現在公開的優秀專題，p-3、p-5、p-8 只在登入後的歷屆一覽。
 */
export const PROJECTS = [
  {
    key: 'p-1', cohort: 'DEMO-113', code: 'G07', advisor: 'u-103', image: 'showcase.jpg', published: '2026-06-20',
    award: 'excellent', awardLabel: '113 學年度校級優秀專題',
    title: '城市微光：公共資訊可讀性改善',
    summary: '針對公部門開放資料網站的資訊可讀性問題，重新設計資料呈現流程。以三個實際的市政資料集為例，建立一套可重複套用的視覺化樣板，並邀請十二位非資訊背景使用者進行可用性測試，量測任務完成時間與理解正確率。',
    video: 'https://www.youtube.com/@fjuim',
    members: ['周子瑜', '許哲瑋', '潘映璇', '簡宇軒', '邱郁婷'],
  },
  {
    key: 'p-2', cohort: 'DEMO-113', code: 'G03', advisor: 'u-102', image: 'phone.jpg', published: '2026-06-20',
    award: 'merit', awardLabel: '113 學年度專題發表 佳作',
    title: '拾語：課堂討論脈絡整理器',
    summary: '課堂討論常因發言分散而難以整理脈絡。本作品以語音轉文字與主題聚類，將討論內容整理成可追溯的議題樹，並提供教師端的重點摘要與未回應問題清單。',
    video: 'https://www.youtube.com/@fjuim',
    members: ['賴威廷', '宋佳蓉', '馮柏勳', '涂雅雯', '石承翰'],
  },
  {
    key: 'p-3', cohort: 'DEMO-113', code: 'G05', advisor: 'u-104', image: 'lounge.jpg', published: '2026-06-20',
    title: '安心路徑：校園友善空間指南',
    summary: '以校園實地盤點為基礎，建立友善空間資料庫，包含無障礙坡道、電梯、哺集乳室與性別友善廁所位置，並提供路徑建議與現場照片。盤點結果已回饋給校內單位。',
    members: ['溫子謙', '范芷妍', '杜宥安', '洪思語', '莊博凱'],
  },
  {
    key: 'p-7', cohort: 'DEMO-113', code: 'G09', advisor: 'u-105', image: 'present.jpg', published: '2026-06-20',
    award: 'merit', awardLabel: '113 學年度專題發表 佳作',
    title: '校園閒置空間共享媒合平台',
    summary: '整合各系所閒置教室與設備的借用流程，以時段媒合減少空間閒置。',
    video: 'https://www.youtube.com/@fjuim',
    members: [],
  },
  {
    key: 'p-4', cohort: 'DEMO-112', code: 'G02', advisor: 'u-105', image: 'hackathon.jpg', published: '2025-06-18',
    award: 'excellent', awardLabel: '112 學年度校級優秀專題・全國賽佳作',
    title: '備援：中小企業備份稽核工具',
    summary: '中小企業常無專責資訊人員，備份策略難以驗證。本作品建立一套備份稽核工具，自動檢查備份完整性、可還原性與保留週期，並產出可交付稽核單位的報告。',
    video: 'https://www.youtube.com/@fjuim',
    members: ['田家瑜', '阮柏毅', '曾語彤', '崔浩然', '翁苡榛'],
  },
  {
    key: 'p-5', cohort: 'DEMO-112', code: 'G06', advisor: 'u-103', image: 'study.jpg', published: '2025-06-18',
    title: '菜市場數位帳本',
    summary: '傳統市場攤商多以紙本記帳。本作品以極簡輸入介面與語音記帳降低使用門檻，並提供進貨與銷售的簡易分析。實際導入三個攤位試用兩個月。',
    video: 'https://www.youtube.com/@fjuim',
    members: ['巫佳蓁', '郝彥丞', '岳庭妤', '解軍豪', '麥若彤'],
  },
  {
    key: 'p-6', cohort: 'DEMO-112', code: 'G11', advisor: 'u-104', image: 'atrium.jpg', published: '2025-06-18',
    award: 'merit', awardLabel: '112 學年度專題發表 佳作',
    title: '無障礙報名流程重構',
    summary: '以校內活動報名流程為對象，重新設計符合 WCAG 2.2 AA 的表單與流程，並以螢幕閱讀器與鍵盤操作完成完整驗證。',
    members: ['柯亦辰', '宮宇薇', '潘冠霖', '尤思穎', '方品瑄'],
  },
  {
    key: 'p-8', cohort: 'DEMO-112', code: 'G04', advisor: 'u-102', image: 'building.jpg', published: '2025-06-18',
    title: '跨境電商稅務試算工具',
    summary: '整理十二國進口稅則，讓小型賣家在上架前試算落地成本。',
    members: [],
  },
]

/**
 * 榮譽榜（原型 `HONORS`）：placement `honor` 的已發布公開項目。標題＝競賽、摘要帶獎項與組別、分類是右邊那顆標籤。
 * 得獎日期＝原型的 `date`（票 39 起年份篩選看 `managed_items.awarded_on`）；發布日也照它。2026 年的掛在示範 113 屆、
 * 2025 年的掛在示範 112 屆。
 */
export const HONORS = [
  { key: 'h-1', cohort: 'DEMO-113', date: '2026-07-07', competition: '全國大專校院資訊應用服務創新競賽', award: '優等', team: '第 04 組', image: 'applause.jpg', category: '校外競賽', summary: '以「備援：中小企業備份稽核工具」參賽，於資訊應用服務創新組獲優等。' },
  { key: 'h-2', cohort: 'DEMO-113', date: '2026-06-15', competition: '跨域設計專題成果展', award: '評審團獎', team: '第 02 組', image: 'trophy.jpg', category: '校內競賽', summary: '以跨系合作的服務設計作品獲評審團獎。' },
  { key: 'h-3', cohort: 'DEMO-113', date: '2026-05-20', competition: '校級學生專題成果競賽', award: '佳作', team: '第 11 組', image: 'present.jpg', category: '校內競賽', summary: '無障礙報名流程重構獲校級佳作。' },
  { key: 'h-4', cohort: 'DEMO-112', date: '2025-12-02', competition: '全國智慧製造大數據分析競賽', award: '第三名', team: '第 06 組', image: 'atrium.jpg', category: '校外競賽', summary: '以設備稼動率預測模型獲第三名。' },
  { key: 'h-5', cohort: 'DEMO-112', date: '2025-11-14', competition: '大專校院資訊服務創新競賽 北區賽', award: '佳作', team: '第 07 組', image: 'students.jpg', category: '校外競賽', summary: '城市微光原型於北區賽獲佳作。' },
  { key: 'h-6', cohort: 'DEMO-112', date: '2025-05-22', competition: '校級學生專題成果競賽', award: '優等', team: '第 03 組', image: 'study.jpg', category: '校內競賽', summary: '拾語：課堂討論脈絡整理器獲校級優等。' },
]

/**
 * 競賽資訊（原型 `COMPETITIONS`）：前台 /competitions 讀分類「競賽資訊」的公告。
 * c-1、c-2 第一批已經有（n-29、n-26）；補 c-3。日期照第一批的平移（跟公告同一條時間線），排在 n-25 之前。
 */
export const COMPETITION_NEWS = [
  {
    key: 'c-3',
    image: 'present.jpg',
    category: '競賽資訊',
    // 票 39：原型 c-3 的報名截止與展出日。
    registrationDeadline: '2026-06-20',
    eventDate: '2026-07-05',
    title: '跨域設計專題成果展',
    summary: '以跨領域合作為主題的校內成果展，本系有兩組作品獲評審推薦。',
    date: '2026-06-01',
    body: [
      '跨域設計專題成果展由校內教學發展中心主辦，以跨領域合作為主題，報名至 2026 年 6 月 20 日止，展出日為 7 月 5 日。',
      '本系有兩組作品獲評審推薦，歡迎有興趣的組別與指導老師討論是否參展。',
    ],
  },
]
