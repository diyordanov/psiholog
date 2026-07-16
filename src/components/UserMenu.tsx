import { LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { logAuditEvent } from '../lib/auditLog';

/**
 * Малка лента с поздрав към логнатия потребител и бутон за изход.
 * Показва се само когато има активна сесия (auth контекстът е зареден и user != null).
 */
export default function UserMenu() {
  const { user } = useAuth();
  const displayName = (user?.user_metadata.display_name as string | undefined) ?? 'Потребител';

  /**
   * Записва audit event за изход (докато сесията все още е активна),
   * след което прекратява сесията в Supabase — това тригва onAuthStateChange
   * в AuthContext и приложението се връща на auth екрана.
   */
  async function handleSignOut() {
    if (user) await logAuditEvent(user.id, 'logout');
    await supabase.auth.signOut();
  }

  return (
    <div className="flex items-center gap-3">
      <span className="hidden text-sm text-neutral-600 sm:inline">
        Здравей, <span className="font-medium text-neutral-800">{displayName}</span>
      </span>
      <button
        onClick={handleSignOut}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:bg-white/70 hover:text-neutral-900"
      >
        <LogOut size={16} />
        <span className="hidden sm:inline">Изход</span>
      </button>
    </div>
  );
}
