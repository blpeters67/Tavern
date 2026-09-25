import { useRef } from 'react';
import type { Channel } from '../store/types';
import ChannelIcon from './ChannelIcon';
import EmojiPicker from './EmojiPicker';
import { Icon, mdiClose } from './icons';
import { Popout, tip, usePopout } from './layers';

/** Pick a channel's sidebar icon from any emoji (or the server's own). */
export default function IconPickerField({
  value,
  type,
  serverId,
  onChange,
}: {
  value: string | null;
  type: Channel['type'];
  serverId: number;
  onChange: (value: string | null) => void;
}) {
  const pop = usePopout();
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="icon-picker-field">
      <button
        type="button"
        ref={button}
        className="icon-picker-button"
        aria-label="Choose channel icon"
        {...tip('Choose an icon')}
        onClick={() => button.current && pop.open(button.current.getBoundingClientRect())}
      >
        <ChannelIcon channel={{ type, emoji: value }} size={22} />
      </button>
      {value && (
        <button type="button" className="icon-picker-clear" aria-label="Use the default icon" {...tip('Use the default icon')} onClick={() => onChange(null)}>
          <Icon path={mdiClose} size={14} />
        </button>
      )}
      {pop.anchor && (
        <Popout anchor={pop.anchor} side="bottom-start" onClose={pop.close} className="emoji-popout">
          <EmojiPicker
            serverId={serverId}
            onPick={(e) => {
              onChange(e.kind === 'custom' ? (e.emoji.server_id === serverId ? `c:${e.emoji.id}` : null) : e.emoji);
              pop.close();
            }}
            onClose={pop.close}
          />
        </Popout>
      )}
    </div>
  );
}
