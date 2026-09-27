import type { CSSProperties } from 'react';

export {
  mdiAccountGroup,
  mdiAccountGroupOutline,
  mdiAccountMultiple,
  mdiAccountPlus,
  mdiAccountRemove,
  mdiAccountVoice,
  mdiAirplane,
  mdiAlert,
  mdiAlertCircle,
  mdiArrowCollapse,
  mdiArrowDown,
  mdiArrowExpand,
  mdiArrowTopRight,
  mdiArrowLeft,
  mdiArrowRight,
  mdiArrowUp,
  mdiAt,
  mdiAutoFix,
  mdiBagPersonal,
  mdiBagPersonalOutline,
  mdiBell,
  mdiBellOff,
  mdiBellOutline,
  mdiBookOpenPageVariant,
  mdiBookOpenPageVariantOutline,
  mdiBookOpenVariant,
  mdiBookshelf,
  mdiCampfire,
  mdiCardAccountDetailsOutline,
  mdiCash,
  mdiCastle,
  mdiCheck,
  mdiCheckCircle,
  mdiChevronDown,
  mdiChevronLeft,
  mdiChevronRight,
  mdiChevronUp,
  mdiCircleMultiple,
  mdiCircleMultipleOutline,
  mdiClockOutline,
  mdiClose,
  mdiCloseCircle,
  mdiClosedCaption,
  mdiCloudUpload,
  mdiCodeTags,
  mdiCog,
  mdiCogOutline,
  mdiCompassRose,
  mdiContentCopy,
  mdiCreation,
  mdiCrown,
  mdiCrownOutline,
  mdiCursorDefault,
  mdiDelete,
  mdiDeleteSweepOutline,
  mdiDiceD10,
  mdiDiceD12,
  mdiDiceD20,
  mdiDiceD20Outline,
  mdiDiceD4,
  mdiDiceD6,
  mdiDiceD8,
  mdiDiceMultiple,
  mdiDiceMultipleOutline,
  mdiDockRight,
  mdiDockWindow,
  mdiDotsHorizontal,
  mdiDotsVertical,
  mdiDownload,
  mdiDragVertical,
  mdiDramaMasks,
  mdiDraw,
  mdiEarHearing,
  mdiEarHearingOff,
  mdiEllipseOutline,
  mdiEmoticonHappy,
  mdiEmoticonOutline,
  mdiEmoticonPlus,
  mdiEye,
  mdiEyedropper,
  mdiEyeOff,
  mdiEyeOffOutline,
  mdiEyeOutline,
  mdiFeather,
  mdiFileDocumentOutline,
  mdiFileMusicOutline,
  mdiFilterVariant,
  mdiFire,
  mdiFlag,
  mdiFolder,
  mdiFood,
  mdiFormatBold,
  mdiFormatColorText,
  mdiFormatItalic,
  mdiFormatQuoteClose,
  mdiFormatSize,
  mdiFormatStrikethrough,
  mdiFormatText,
  mdiFormatUnderline,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiGavel,
  mdiHeadphones,
  mdiHeadphonesOff,
  mdiHeart,
  mdiHeartPulse,
  mdiHistory,
  mdiHome,
  mdiHomeOutline,
  mdiImage,
  mdiImageOutline,
  mdiInformation,
  mdiInformationOutline,
  mdiLightbulbOn,
  mdiLightningBolt,
  mdiLink,
  mdiLinkVariant,
  mdiLock,
  mdiLockOpenVariantOutline,
  mdiLogout,
  mdiMagicStaff,
  mdiMagnify,
  mdiMenu,
  mdiMenuDown,
  mdiMenuUp,
  mdiMessage,
  mdiMessageText,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiMicrophoneSettings,
  mdiMinus,
  mdiMinusCircle,
  mdiMonitor,
  mdiMonitorOff,
  mdiMonitorShare,
  mdiMovieOpen,
  mdiMovieOpenOutline,
  mdiMovieOpenPlay,
  mdiMusic,
  mdiMusicBoxMultiple,
  mdiMusicNote,
  mdiMusicNotePlus,
  mdiNoteText,
  mdiOpenInNew,
  mdiPause,
  mdiPauseCircle,
  mdiPaw,
  mdiPencil,
  mdiPencilOutline,
  mdiPhone,
  mdiPhoneHangup,
  mdiPictureInPictureBottomRight,
  mdiPin,
  mdiPinOff,
  mdiPlay,
  mdiPlayCircle,
  mdiPlaylistMusic,
  mdiPlaylistPlay,
  mdiPlaylistPlus,
  mdiPlus,
  mdiPlusCircle,
  mdiPlusCircleOutline,
  mdiRectangleOutline,
  mdiRedo,
  mdiRefresh,
  mdiRepeat,
  mdiRepeatOff,
  mdiRepeatOnce,
  mdiReply,
  mdiResizeBottomRight,
  mdiRestore,
  mdiRuler,
  mdiRun,
  mdiScaleBalance,
  mdiScriptOutline,
  mdiScriptText,
  mdiScriptTextOutline,
  mdiSend,
  mdiShield,
  mdiShieldAccount,
  mdiShieldCrownOutline,
  mdiShieldOutline,
  mdiShieldSword,
  mdiShimmer,
  mdiShuffleDisabled,
  mdiShuffleVariant,
  mdiSignal,
  mdiSkipNext,
  mdiSkipPrevious,
  mdiSkull,
  mdiSlashForward,
  mdiSoccer,
  mdiSofaSingle,
  mdiSofaSingleOutline,
  mdiSync,
  mdiStar,
  mdiStarFourPoints,
  mdiStarOutline,
  mdiStop,
  mdiSword,
  mdiSwordCross,
  mdiTagOutline,
  mdiTelevisionPlay,
  mdiTextBoxOutline,
  mdiTrashCanOutline,
  mdiTreasureChest,
  mdiTune,
  mdiUndo,
  mdiUpload,
  mdiVideo,
  mdiVideoOff,
  mdiViewGrid,
  mdiVolumeHigh,
  mdiVolumeLow,
  mdiVolumeMedium,
  mdiVolumeOff,
  mdiWaveform,
  mdiWeatherNight,
  mdiYoutube,
} from '@mdi/js';

// Our own hash sign: slanted like a hand-drawn "#".
export const iconHash =
  'M10.1 3h2.05l-.9 5.1h4.05L16.2 3h2.05l-.9 5.1H21v2h-3.95l-.75 3.9H20v2h-4.05l-.95 5H13l.95-5H9.9l-.95 5H6.9l.95-5H4v-2h4.2l.75-3.9H5v-2h4.2zm.75 7.1-.75 3.9h4.05l.75-3.9z';

// Text effects: the "T" of the format bar with little sparkles around it.
export function TextFxIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <g fill="currentColor">
        <path
          transform="translate(-2.2 2.2) scale(0.86)"
          d="M18.5,4L19.66,8.35L18.7,8.61C18.25,7.74 17.79,6.87 17.26,6.43C16.73,6 16.11,6 15.5,6H13V16.5C13,17 13,17.5 13.33,17.75C13.67,18 14.33,18 15,18V19H9V18C9.67,18 10.33,18 10.67,17.75C11,17.5 11,17 11,16.5V6H8.5C7.89,6 7.27,6 6.74,6.43C6.21,6.87 5.75,7.74 5.3,8.61L4.34,8.35L5.5,4H18.5Z"
        />
        <path d="M18.6 1.2l.95 2.75 2.75.95-2.75.95-.95 2.75-.95-2.75-2.75-.95 2.75-.95z" />
        <path d="M20.9 10.4l.5 1.45 1.45.5-1.45.5-.5 1.45-.5-1.45-1.45-.5 1.45-.5z" />
        <path d="M3.4 17.9l.45 1.3 1.3.45-1.3.45-.45 1.3-.45-1.3-1.3-.45 1.3-.45z" />
      </g>
    </svg>
  );
}

// Tavern logo: a tankard with a foamy head.
export function TavernLogo({ size = 28, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={style}>
      <g fill="currentColor">
        <circle cx="7.2" cy="7.3" r="2.7" />
        <circle cx="10.6" cy="5.7" r="3.2" />
        <circle cx="14.1" cy="7.1" r="2.6" />
        <rect x="4.6" y="7.2" width="12.1" height="3.2" rx="1" />
        <path
          fillRule="evenodd"
          d="M5 10h10.6v9a2.2 2.2 0 0 1-2.2 2.2H7.2A2.2 2.2 0 0 1 5 19zM7.6 12.3h1.3v6.7H7.6zm2.5 0h1.3v6.7h-1.3zm2.5 0h1.3v6.7h-1.3z"
        />
        <path d="M15.6 11.6h2.6a2.8 2.8 0 0 1 2.8 2.8v1.9a2.8 2.8 0 0 1-2.8 2.8h-2.6v-2h2.6a.8.8 0 0 0 .8-.8v-1.9a.8.8 0 0 0-.8-.8h-2.6z" />
      </g>
    </svg>
  );
}

export function Icon({
  path,
  size = 24,
  className,
  style,
  title,
}: {
  path: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path fill="currentColor" d={path} />
    </svg>
  );
}
