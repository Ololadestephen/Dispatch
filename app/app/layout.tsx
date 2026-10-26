import type { ReactNode } from 'react';
import { DeskProvider } from '@/src/client/DeskProvider';
import { AppShell } from '@/src/components/app/AppShell';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <DeskProvider>
      <AppShell>{children}</AppShell>
    </DeskProvider>
  );
}
