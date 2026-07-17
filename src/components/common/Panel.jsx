import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function Panel({ title, icon: Icon, headerAction, children }) {
  return (
    <Card className="gap-4 rounded-lg py-5">
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        {headerAction && <CardAction>{headerAction}</CardAction>}
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  );
}
