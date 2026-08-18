import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "fju-project";

/** 分組總覽。固定欄寬、單行 cell，長內容以 ellipsis 處理。 */
export const GroupList = () => (
  <div className="w-[46rem] overflow-hidden rounded-lg border border-border">
    <Table className="table-fixed">
      <TableHeader className="bg-muted">
        <TableRow>
          <TableHead style={{ width: "88px" }}>組別</TableHead>
          <TableHead style={{ width: "260px" }}>專題題目</TableHead>
          <TableHead style={{ width: "104px" }}>類型</TableHead>
          <TableHead style={{ width: "108px" }}>指導老師</TableHead>
          <TableHead style={{ width: "80px" }}>人數</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[
          { no: "第 07 組", title: "校園閒置空間共享媒合平台", type: "一般專題", t: "陳建宏", n: 5 },
          { no: "第 02 組", title: "零售門市補貨預測（產學：宏昇物流）", type: "產學合作", t: "陳建宏", n: 5 },
          { no: "第 03 組", title: "非營利組織捐款流程數位化", type: "產學合作", t: "尚未指派", n: 5 },
          { no: "第 09 組", title: "跨境電商稅務試算工具", type: "一般專題", t: "尚未指派", n: 4 },
        ].map((r) => (
          <TableRow key={r.no}>
            <TableCell className="tabular">{r.no}</TableCell>
            <TableCell className="truncate font-medium">{r.title}</TableCell>
            <TableCell>
              {r.type === "產學合作" ? (
                <Badge variant="outline" className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle">
                  產學合作
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[11px] text-muted-foreground">
                  一般專題
                </Badge>
              )}
            </TableCell>
            <TableCell className={r.t === "尚未指派" ? "text-muted-foreground" : ""}>{r.t}</TableCell>
            <TableCell className={`tabular ${r.n !== 5 ? "font-semibold text-warning-on-subtle" : ""}`}>
              {r.n} 人
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);
