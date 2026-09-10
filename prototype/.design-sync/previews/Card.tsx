import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "fju-project";

export const AffairItem = () => (
  <Card className="w-80">
    <CardHeader>
      <CardTitle>指導老師意願調查表</CardTitle>
      <CardDescription>
        填寫三個志願的指導老師順序，並簡述題目方向。整組共用一份。
      </CardDescription>
    </CardHeader>
    <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
      <Badge variant="outline" className="border-info/30 bg-info-subtle text-info-on-subtle">
        草稿
      </Badge>
      <span className="tabular">截止 2026-08-26・剩 9 天</span>
    </CardContent>
    <CardFooter className="gap-2">
      <Button size="sm">繼續填寫</Button>
      <Button size="sm" variant="outline">
        查看說明
      </Button>
    </CardFooter>
  </Card>
);

export const StatTile = () => (
  <Card className="w-56">
    <CardHeader>
      <CardDescription>本屆已分組學生</CardDescription>
      <CardTitle className="tabular text-3xl">44 人</CardTitle>
    </CardHeader>
    <CardContent className="text-xs text-muted-foreground">
      未分組 4 人・例外組 1 組
    </CardContent>
  </Card>
);
