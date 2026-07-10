import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export function AppBreadcrumb({ project, task, taskProject, page, onShowInbox, onShowProject }) {
  const visibleProject = taskProject || project;

  return (
    <Breadcrumb className="mb-1">
      <BreadcrumbList className="flex-nowrap text-xs">
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbLink asChild>
            <button className="truncate" type="button" onClick={onShowInbox}>
              Smart inbox
            </button>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {visibleProject && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbLink asChild>
                <button className="truncate" type="button" onClick={onShowProject}>
                  {visibleProject.name}
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </>
        )}
        {task && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate">{task.title}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
        {page && !task && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate">{page}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
