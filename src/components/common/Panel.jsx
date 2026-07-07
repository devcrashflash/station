import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function Panel({ title, icon: Icon, children }) {
  return (
    <Card className="gap-4 rounded-lg py-5">
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  );
}
