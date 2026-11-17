import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function DemoBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="gap-1 border-warning/40 bg-warning-subtle text-warning">
          <FlaskConical className="size-3" aria-hidden />
          Demo data · trading disabled
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        Prices, trades and rankings are generated fixtures. Nothing can be submitted.
      </TooltipContent>
    </Tooltip>
  );
}
