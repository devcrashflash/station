import { cn } from "@/lib/utils";

export function BurningTreeIcon({ className, ...props }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      {...props}
    >
      <g
        className="text-blue-600 dark:text-blue-400"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 3 5.5 7.7h2.1l-3 3.7h2.5l-2.3 3.1h7.7l-2-3.1H13l-3-3.7h2.1L9 3Z" />
        <path d="M9 14.5V20.5" />
      </g>
      <g className="burning-tree-icon__flame text-orange-500 dark:text-orange-400">
        <path
          d="M17.2 3.5c.5 3.2-3.1 4.4-1.9 7.3.8-1.2 1.9-2 3-2.6.3 1.8 2.9 3.7 2.9 6.7a6 6 0 0 1-12 0c0-4 2.8-7.1 8-11.4Z"
          fill="currentColor"
        />
        <path
          d="M16.2 12.9c.2 1.7-1.3 2.4-.8 4 .5-.7 1-1.1 1.7-1.4.2 1 1.3 1.8 1.3 3.1a2.9 2.9 0 0 1-5.8 0c0-1.9 1.3-3.6 3.6-5.7Z"
          className="text-amber-200 dark:text-amber-100"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}
