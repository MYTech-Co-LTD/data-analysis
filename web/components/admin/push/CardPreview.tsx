// web/components/admin/push/CardPreview.tsx
// 企微 template_card news_notice 预览 mock（只读渲染 card_json，样式贴近企微客户端）
'use client';

export interface PreviewCard {
  card_type?: string;
  source?: { desc?: string; desc_color?: number };
  main_title?: { title?: string; desc?: string };
  card_image?: { url?: string; aspect_ratio?: number };
  vertical_content_list?: Array<{ title?: string; value?: string }>;
  card_action?: { type?: number; url?: string };
}

const SOURCE_COLORS = ['#888', '#333', '#e54f42', '#14ae67'];

export default function CardPreview({ card }: { card: PreviewCard }) {
  const ratio = card.card_image?.aspect_ratio ?? 1.3;
  return (
    <div className="w-[340px] rounded-xl bg-white shadow-md overflow-hidden border border-slate-200">
      {card.source?.desc && (
        <div className="px-3 pt-2 text-xs flex items-center gap-1.5" style={{ color: SOURCE_COLORS[card.source.desc_color ?? 0] }}>
          <span className="inline-block w-3 h-3 rounded-full bg-slate-300" />{card.source.desc}
        </div>
      )}
      <div className="px-3 py-2">
        <div className="text-base font-semibold text-slate-900">{card.main_title?.title || '（主标题）'}</div>
        {card.main_title?.desc && <div className="text-xs text-slate-500 mt-1">{card.main_title.desc}</div>}
      </div>
      {card.card_image?.url && (
        // eslint-disable-next-line @next/next/no-img-element -- 企微卡片 mock 预览：图片 URL 是渲染期用户数据，非本地静态资源，next/image 语义不符（aspectRatio/onError 动态控制）
        <img
          src={card.card_image.url}
          alt="卡片大图"
          className="w-full object-cover"
          style={{ aspectRatio: String(ratio) }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      {card.vertical_content_list?.length ? (
        <div className="px-3 py-2 space-y-1.5">
          {card.vertical_content_list.map((row, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-slate-500">{row.title}</span>
              <span className="text-slate-900 font-medium tabular-nums">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {card.card_action?.url && (
        <div className="px-3 py-2 text-xs text-slate-400 truncate border-t border-slate-100">
          点击卡片跳转：{card.card_action.url}
        </div>
      )}
    </div>
  );
}
