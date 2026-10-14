import React from 'react';

/**
 * High-performance, lightweight shimmer Skeleton for Non-Blocking Dashboard Rendering
 */
export default function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse p-4 md:p-6 max-w-7xl mx-auto">
      {/* Top Header Skeleton */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="h-8 w-48 bg-slate-800 rounded-lg mb-2"></div>
          <div className="h-4 w-72 bg-slate-800/60 rounded"></div>
        </div>
        <div className="flex gap-2">
          <div className="h-10 w-32 bg-slate-800 rounded-lg"></div>
          <div className="h-10 w-32 bg-slate-800 rounded-lg"></div>
        </div>
      </div>

      {/* KPI Cards Row (4 cards) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="h-4 w-24 bg-slate-800 rounded"></div>
              <div className="w-8 h-8 rounded-lg bg-slate-800"></div>
            </div>
            <div className="h-8 w-20 bg-slate-800/90 rounded"></div>
            <div className="h-3 w-36 bg-slate-800/50 rounded"></div>
          </div>
        ))}
      </div>

      {/* Main Grid Section (2 Tables / Cards) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Card Skeleton */}
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 space-y-4">
          <div className="flex justify-between items-center pb-3 border-b border-slate-800">
            <div className="h-5 w-36 bg-slate-800 rounded"></div>
            <div className="h-4 w-16 bg-slate-800/60 rounded"></div>
          </div>
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((r) => (
              <div key={r} className="flex items-center justify-between py-2 border-b border-slate-800/40">
                <div className="space-y-1.5">
                  <div className="h-4 w-28 bg-slate-800 rounded"></div>
                  <div className="h-3 w-40 bg-slate-800/50 rounded"></div>
                </div>
                <div className="h-6 w-20 bg-slate-800/80 rounded-full"></div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Card Skeleton */}
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 space-y-4">
          <div className="flex justify-between items-center pb-3 border-b border-slate-800">
            <div className="h-5 w-36 bg-slate-800 rounded"></div>
            <div className="h-4 w-16 bg-slate-800/60 rounded"></div>
          </div>
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((r) => (
              <div key={r} className="flex items-center justify-between py-2 border-b border-slate-800/40">
                <div className="space-y-1.5">
                  <div className="h-4 w-28 bg-slate-800 rounded"></div>
                  <div className="h-3 w-40 bg-slate-800/50 rounded"></div>
                </div>
                <div className="h-6 w-20 bg-slate-800/80 rounded-full"></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
