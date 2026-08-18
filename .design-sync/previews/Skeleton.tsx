import { Skeleton } from "fju-project";

/** Data Table 的載入狀態 —— 與空白、錯誤、無權限是不同狀態 */
export const TableLoading = () => (
  <div className="w-[32rem] space-y-3 rounded-lg border border-border p-4">
    {[0, 1, 2, 3].map((i) => (
      <div key={i} className="flex items-center gap-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 flex-1" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-12" />
      </div>
    ))}
  </div>
);

export const CardLoading = () => (
  <div className="w-72 overflow-hidden rounded-xl border border-border">
    <Skeleton className="aspect-[16/10] w-full rounded-none" />
    <div className="space-y-2 p-4">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  </div>
);
