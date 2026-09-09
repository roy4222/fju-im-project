import { Tabs, TabsContent, TabsList, TabsTrigger } from "fju-project";

/** 公告分類切換 */
export const NewsCategories = () => (
  <Tabs defaultValue="all" className="w-[26rem]">
    <TabsList>
      <TabsTrigger value="all">全部</TabsTrigger>
      <TabsTrigger value="affairs">專題事務</TabsTrigger>
      <TabsTrigger value="contest">競賽資訊</TabsTrigger>
      <TabsTrigger value="rules">規則異動</TabsTrigger>
    </TabsList>
    <TabsContent value="all" className="pt-4 text-sm text-muted-foreground">
      顯示全部 7 則公告，依發布日期排序。
    </TabsContent>
  </Tabs>
);

export const LineVariant = () => (
  <Tabs defaultValue="pending" className="w-[26rem]">
    <TabsList variant="line">
      <TabsTrigger value="pending">待評分</TabsTrigger>
      <TabsTrigger value="staged">已暫存</TabsTrigger>
      <TabsTrigger value="submitted">已送出</TabsTrigger>
    </TabsList>
    <TabsContent value="pending" className="pt-4 text-sm text-muted-foreground">
      2 組尚未開始評分。
    </TabsContent>
  </Tabs>
);
