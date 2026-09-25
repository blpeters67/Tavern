import { ChannelEmoji } from '../lib/markdown';
import type { Channel } from '../store/types';
import { ChannelType } from '../store/types';
import { Icon, mdiTextBoxOutline, mdiVolumeHigh } from './icons';

/** The icon shown before a channel's name: its emoji, or a page / speaker. */
export default function ChannelIcon({ channel, size = 20, className }: { channel: Pick<Channel, 'type' | 'emoji'>; size?: number; className?: string }) {
  if (channel.emoji) return <ChannelEmoji emoji={channel.emoji} className={`channel-glyph ${className ?? ''}`} />;
  return <Icon path={channel.type === ChannelType.VOICE ? mdiVolumeHigh : mdiTextBoxOutline} size={size} className={`channel-glyph ${className ?? ''}`} />;
}
