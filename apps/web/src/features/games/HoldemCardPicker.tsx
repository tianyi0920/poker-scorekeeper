import { useState } from 'react';
import { Modal } from '../../components/Modal.js';
import { holdemCardName, holdemCardText, holdemCardTone, type HoldemCard } from './holdem-equity.js';

const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
const suits = [
  { code: 's', symbol: '♠', name: '黑桃' },
  { code: 'h', symbol: '♥', name: '红桃' },
  { code: 'c', symbol: '♣', name: '梅花' },
  { code: 'd', symbol: '♦', name: '方片' }
] as const;

export function HoldemCardPicker({
  title,
  initialCards,
  requiredCount,
  excludedCards,
  onClose,
  onClear,
  onConfirm
}: {
  title: string;
  initialCards: HoldemCard[];
  requiredCount: number;
  excludedCards: HoldemCard[];
  onClose: () => void;
  onClear: () => void;
  onConfirm: (cards: HoldemCard[]) => void;
}) {
  const [selectedCards, setSelectedCards] = useState<HoldemCard[]>(initialCards);
  const [selectedRank, setSelectedRank] = useState<(typeof ranks)[number] | null>(null);
  const unavailableCards = new Set([...excludedCards, ...selectedCards]);

  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body holdem-card-picker">
        <div className="holdem-picked-cards" aria-label="已选择的牌">
          {Array.from({ length: requiredCount }, (_, index) => {
            const card = selectedCards[index];
            return card === undefined ? (
              <span className="holdem-picked-card holdem-picked-card--empty" key={index}>+</span>
            ) : (
              <button
                type="button"
                className={`holdem-picked-card holdem-picked-card--${holdemCardTone(card)}`}
                key={card}
                aria-label={`移除 ${holdemCardName(card)}`}
                onClick={() => setSelectedCards((current) => current.filter((selected) => selected !== card))}
              >{holdemCardText(card)}</button>
            );
          })}
        </div>

        <p className="holdem-picker-hint">先选点数，再选花色</p>
        <div className="holdem-rank-grid" aria-label="选择点数">
          {ranks.map((rank) => (
            <button
              type="button"
              key={rank}
              aria-label={`选择点数 ${rank}`}
              aria-pressed={selectedRank === rank}
              onClick={() => setSelectedRank(rank)}
            >{rank === 'T' ? '10' : rank}</button>
          ))}
        </div>
        <div className="holdem-suit-grid" aria-label="选择花色">
          {suits.map(({ code, symbol, name }) => {
            const card = selectedRank === null ? undefined : `${selectedRank}${code}` as HoldemCard;
            return (
              <button
                type="button"
                className={code === 'h' || code === 'd' ? 'holdem-suit--red' : ''}
                key={code}
                aria-label={`选择花色 ${name}`}
                disabled={card === undefined || unavailableCards.has(card) || selectedCards.length >= requiredCount}
                onClick={() => {
                  if (card === undefined) return;
                  setSelectedCards((current) => [...current, card]);
                  setSelectedRank(null);
                }}
              >{symbol} {name}</button>
            );
          })}
        </div>
        <div className="holdem-picker-actions">
          <button type="button" className="button button--ghost" onClick={onClear}>清空本组</button>
          <button
            type="button"
            className="button"
            disabled={selectedCards.length !== requiredCount}
            onClick={() => onConfirm(selectedCards)}
          >确认选牌</button>
        </div>
      </div>
    </Modal>
  );
}
