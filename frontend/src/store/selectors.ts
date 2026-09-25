import { ALL, channelPermissions, basePermissions, P, type PermContext } from '../lib/permissions';
import { colorHex } from '../lib/format';
import type { State } from './store';
import type { Channel, Character, Member, Role, Server, User, VoiceState } from './types';
import { ChannelType, NARRATOR } from './types';

export function displayName(u: Pick<User, 'display_name' | 'username'> | null | undefined): string {
  if (!u) return 'Unknown User';
  return u.display_name || u.username;
}

export function permCtx(s: State, serverId: number): PermContext | null {
  const server = s.servers[serverId];
  if (!server || !s.me) return null;
  return { server, roles: s.roles, member: s.members[serverId]?.[s.me.id], channels: s.channels };
}

interface PermMemo {
  me: State['me'];
  server: Server | undefined;
  roles: State['roles'];
  member: Member | undefined;
  parent: Channel | undefined;
  value: number;
}

// Every message on screen asks for your permissions in its channel whenever
// the store changes; the answer only changes when one of its inputs does.
const permMemo = new WeakMap<Channel, PermMemo>();

export function myChannelPerms(s: State, channel: Channel | undefined): number {
  if (!channel || !s.me) return 0;
  const server = channel.server_id === null ? undefined : s.servers[channel.server_id];
  const member = channel.server_id === null ? undefined : s.members[channel.server_id]?.[s.me.id];
  const parent = channel.parent_id ? s.channels[channel.parent_id] : undefined;
  const hit = permMemo.get(channel);
  if (hit && hit.me === s.me && hit.server === server && hit.roles === s.roles && hit.member === member && hit.parent === parent) return hit.value;
  let value = 0;
  if (channel.server_id === null) value = channelPermissions({ server: null as never, roles: {}, member: undefined, channels: {} }, s.me.id, channel);
  else {
    const ctx = permCtx(s, channel.server_id);
    value = ctx ? channelPermissions(ctx, s.me.id, channel) : 0;
  }
  permMemo.set(channel, { me: s.me, server, roles: s.roles, member, parent, value });
  return value;
}

export function myServerPerms(s: State, serverId: number): number {
  const ctx = permCtx(s, serverId);
  return ctx && s.me ? basePermissions(ctx, s.me.id) : 0;
}

export const canView = (s: State, c: Channel) => (myChannelPerms(s, c) & P.VIEW_CHANNEL) !== 0;

export function isPrivate(c: Channel | undefined): boolean {
  return !!c && (c.type === ChannelType.DM || c.type === ChannelType.GROUP_DM);
}

export interface ChannelGroup {
  category: Channel | null;
  channels: Channel[];
}

/** Channels of a server grouped under categories, in order. `kind` picks the
 * text or the voice section; a category can hold both, and shows in each
 * section that has channels in it. */
export function groupedChannels(s: State, serverId: number, includeHidden = false, kind: 'text' | 'voice' = 'text'): ChannelGroup[] {
  const all = Object.values(s.channels).filter((c) => c.server_id === serverId);
  const visible = (c: Channel) => includeHidden || canView(s, c);
  const byPos = (a: Channel, b: Channel) => a.position - b.position || a.id - b.id;
  const type = kind === 'voice' ? ChannelType.VOICE : ChannelType.TEXT;
  const categories = all.filter((c) => c.type === ChannelType.CATEGORY).sort(byPos);
  const items = all.filter((c) => c.type === type && visible(c)).sort(byPos);
  const groups: ChannelGroup[] = [{ category: null, channels: items.filter((c) => !c.parent_id || !s.channels[c.parent_id]) }];
  const isAdminish = (myServerPerms(s, serverId) & P.MANAGE_CHANNELS) !== 0;
  for (const cat of categories) {
    const children = items.filter((c) => c.parent_id === cat.id);
    const hasOtherKind = all.some((c) => c.parent_id === cat.id && c.type !== type && c.type !== ChannelType.CATEGORY);
    // Empty categories live in the text section; hide ones you can't see into.
    const showEmpty = kind === 'text' && !hasOtherKind && (isAdminish || includeHidden);
    if (children.length || showEmpty || (includeHidden && kind === 'text')) groups.push({ category: cat, channels: children });
  }
  return groups;
}

export function firstChannel(s: State, serverId: number): Channel | undefined {
  for (const g of groupedChannels(s, serverId)) if (g.channels.length) return g.channels[0];
  return undefined;
}

export function isUnread(s: State, c: Channel): boolean {
  if (!c.last_message_id) return false;
  const rs = s.readStates[c.id];
  return c.last_message_id > (rs?.last_read_id ?? 0);
}

export const mentionCount = (s: State, channelId: number) => s.readStates[channelId]?.mention_count ?? 0;

export function serverBadge(s: State, serverId: number): { unread: boolean; mentions: number } {
  let unread = false;
  let mentions = 0;
  for (const c of Object.values(s.channels)) {
    if (c.server_id !== serverId || c.type !== ChannelType.TEXT) continue;
    if (!canView(s, c)) continue;
    if (isUnread(s, c)) unread = true;
    mentions += mentionCount(s, c.id);
  }
  return { unread, mentions };
}

export function sortedRoles(s: State, serverId: number): Role[] {
  return Object.values(s.roles)
    .filter((r) => r.server_id === serverId)
    .sort((a, b) => b.position - a.position || a.id - b.id);
}

export function memberRoles(s: State, serverId: number, userId: number): Role[] {
  const m = s.members[serverId]?.[userId];
  if (!m) return [];
  return m.role_ids
    .map((id) => s.roles[id])
    .filter(Boolean)
    .sort((a, b) => b.position - a.position);
}

const colorMemo = new WeakMap<Member, { roles: State['roles']; value: string | undefined }>();

/** The colour of someone's highest coloured role (worked out once per member and role change). */
export function roleColor(s: State, serverId: number | null | undefined, userId: number): string | undefined {
  if (!serverId) return undefined;
  const member = s.members[serverId]?.[userId];
  if (!member) return undefined;
  const hit = colorMemo.get(member);
  if (hit && hit.roles === s.roles) return hit.value;
  const role = memberRoles(s, serverId, userId).find((r) => r.color);
  const value = role ? colorHex(role.color) : undefined;
  colorMemo.set(member, { roles: s.roles, value });
  return value;
}

export function myCharacters(s: State): Character[] {
  if (!s.me) return [];
  const id = s.me.id;
  return Object.values(s.characters)
    .filter((c) => c.owner_id === id && !c.deleted)
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

export function charactersOf(s: State, userId: number): Character[] {
  return Object.values(s.characters)
    .filter((c) => c.owner_id === userId && !c.deleted)
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

/** Who you're speaking as in a channel: 0 = yourself, -1 = narrator, otherwise a character id. */
export function personaFor(s: State, channelId: number | null): number {
  if (!s.me || channelId === null) return 0;
  const channel = s.channels[channelId];
  if (channel && !(myChannelPerms(s, channel) & P.USE_CHARACTERS)) return 0;
  const remember = s.me.settings.switch_remember;
  const id = remember ? (s.personaByChannel[channelId] ?? 0) : s.globalPersona;
  if (!id) return 0;
  if (id === NARRATOR) return channel?.server_id && isDm(s, channel.server_id) ? NARRATOR : 0;
  const ch = s.characters[id];
  return ch && !ch.deleted && ch.owner_id === s.me.id ? id : 0;
}

/** Dungeon Master (or owner/admin) in this server. */
export function isDm(s: State, serverId: number | null | undefined): boolean {
  if (!serverId) return false;
  return (myServerPerms(s, serverId) & P.DUNGEON_MASTER) !== 0;
}

export function userIsDm(s: State, serverId: number, userId: number): boolean {
  const ctx = permCtx(s, serverId);
  if (!ctx) return false;
  const member = s.members[serverId]?.[userId];
  return (basePermissions({ ...ctx, member }, userId) & P.DUNGEON_MASTER) !== 0;
}

/** DJs run the jukebox, except while DM Lock is on, when only DMs do. */
export function canControlJukebox(s: State, serverId: number): boolean {
  const perms = myServerPerms(s, serverId);
  if (perms & P.DUNGEON_MASTER) return true;
  if (s.servers[serverId]?.roleplay_mode) return false;
  return (perms & P.DJ) !== 0;
}

/** The theater follows the same rule as the jukebox: DJs, or only Dungeon Masters under DM Lock. */
export const canControlTheater = canControlJukebox;

export function voiceMembers(s: State, channelId: number): VoiceState[] {
  return Object.values(s.voiceStates)
    .filter((v) => v.channel_id === channelId)
    .sort((a, b) => a.joined_at - b.joined_at || a.user_id - b.user_id);
}

export function narratorName(s: State, serverId: number | null | undefined): string {
  return (serverId && s.servers[serverId]?.narrator_name) || 'The GM';
}

export function channelTitle(s: State, c: Channel | undefined): string {
  if (!c) return '';
  if (c.type === ChannelType.DM || c.type === ChannelType.GROUP_DM) {
    if (c.name) return c.name;
    const others = (c.recipient_ids ?? []).filter((id) => id !== s.me?.id);
    if (!others.length) return displayName(s.me);
    return others.map((id) => displayName(s.users[id])).join(', ');
  }
  return c.name ?? '';
}

export function dmPartner(s: State, c: Channel): User | undefined {
  if (c.type !== ChannelType.DM) return undefined;
  const other = (c.recipient_ids ?? []).find((id) => id !== s.me?.id);
  return other ? s.users[other] : undefined;
}

export function canManageRole(s: State, serverId: number, role: Role): boolean {
  const ctx = permCtx(s, serverId);
  if (!ctx || !s.me) return false;
  if (ctx.server.owner_id === s.me.id) return true;
  const perms = basePermissions(ctx, s.me.id);
  if (!(perms & P.MANAGE_ROLES)) return false;
  const top = Math.max(0, ...(ctx.member?.role_ids ?? []).map((r) => s.roles[r]?.position ?? 0));
  return role.position < top;
}

export function outranks(s: State, serverId: number, targetId: number): boolean {
  const server = s.servers[serverId];
  if (!server || !s.me) return false;
  if (targetId === server.owner_id) return false;
  if (s.me.id === server.owner_id) return true;
  const top = (uid: number) => Math.max(0, ...(s.members[serverId]?.[uid]?.role_ids ?? []).map((r) => s.roles[r]?.position ?? 0));
  return top(s.me.id) > top(targetId);
}

export const isAll = (perms: number) => perms === ALL;
