import { useEffect, useState } from 'react';
import { jackyTaskSocket } from '@/lib/ccode-task-socket';
import type { JackyQueueStatus } from '@/lib/ccode-task-client';

export function useQueueStatus() {
  const [queueStatus, setQueueStatus] = useState<JackyQueueStatus | null>(null);

  useEffect(() => {
    const unsubscribe = jackyTaskSocket.subscribeQueue(stats => setQueueStatus(stats));
    return () => {
      unsubscribe();
    };
  }, []);

  return queueStatus;
}
