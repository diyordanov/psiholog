import { LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';

export default function UserMenu() {
  const { user } = useAuth();
  const displayName = (user?.user_metadata.display_name as string | undefined) ?? 'Потребител';

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  return (
    <div className="flex items-center justify-between px-6 py-4">
      <span className="text-sm text-neutral-700">Здравей, {displayName}</span>
      <button
        onClick={handleSignOut}
        className="flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"
      >
        <LogOut size={16} />
        Изход
      </button>
    </div>
  );
}
