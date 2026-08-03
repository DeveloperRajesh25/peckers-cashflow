import { Skeleton } from "@/components/ui/Skeleton";
import { PageHeaderSkeleton, StatCardsSkeleton } from "@/components/ui/Skeletons";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4 sm:gap-5">
        <Skeleton className="h-44 w-full rounded-2xl" />
        <StatCardsSkeleton count={4} />
        <Skeleton className="h-80 w-full rounded-2xl" />
        <Skeleton className="h-80 w-full rounded-2xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    </>
  );
}
