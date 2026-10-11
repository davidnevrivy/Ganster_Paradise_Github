'use strict';
/*
 * The 7 named characters. `side` drives the win condition group.
 * Abilities/weaknesses are implemented in game/engine.js; this file is the
 * canonical description + flavour text (Czech) shown to the owning player
 * once the game ends (or to the player themself any time via "my panel").
 */

const CHARACTERS = {
  pestitel: {
    id: 'pestitel',
    name: 'Lord Edmund Ashcombe, Pěstitel',
    side: 'lords',
    ability: 'Zasej stojí 400 000 £; jeho zasetí nezvyšuje vyšetřování; automatická razie na jeho panství se neprovede (pátrací karta propadne).',
    weakness: 'Nesmí hrát kartu Přesun úrody.',
  },
  dedic: {
    id: 'dedic',
    name: 'Rupert Wexley, Mladý dědic',
    side: 'lords',
    ability: 'Každé panství kupuje o 100 000 £ levněji (u všech lordů).',
    weakness: 'Nesmí přihazovat v dražbě o své vlastní zabavené panství.',
  },
  hrabe: {
    id: 'hrabe',
    name: 'Hrabě Percival Greaves',
    side: 'lords',
    ability: 'Prověř stojí 0 £; Informátor mu ukáže 3 žetony.',
    weakness: 'Kompromitující materiál na něj vždy bere 300 000 £ (nebo vše, co má) — nikdy karty.',
  },
  inspektor: {
    id: 'inspektor',
    name: 'Inspektor Alastair Crane',
    side: 'police',
    ability: 'Jeho Razii nelze zrušit Úplatkem ani přesměrovat Falešnou stopou.',
    weakness: 'Nesmí použít Úplatek.',
  },
  vymahac: {
    id: 'vymahac',
    name: 'Declan Rourke, Vymahač',
    side: 'police',
    ability: '+100 000 £ k příjmu každé kolo (Výpalné); jeho Nepřátelskou nabídku nelze odmítnout; +100 000 £ k nabídce v Dědickém řízení (útok i obrana, platí se jen vlastní část).',
    weakness: 'Nesmí použít Právníka.',
  },
  celnik: {
    id: 'celnik',
    name: 'Sid Barlow, Celník',
    side: 'police',
    ability: 'Úplatek stojí 0 £.',
    weakness: 'V každé dražbě musí nabídnout aspoň 100 000 £, má-li je.',
  },
  investor: {
    id: 'investor',
    name: 'Conrad Vance, Investor',
    side: 'renegade',
    ability: 'Nákup panství od obyčejného lorda o 100 000 £ levněji.',
    weakness: 'Nesmí odmítnout Nepřátelskou nabídku.',
  },
};

const LORD_SIDE_CHARACTERS = ['pestitel', 'dedic', 'hrabe'];
const POLICE_SIDE_CHARACTERS = ['inspektor', 'vymahac', 'celnik'];
const INVESTOR_CHARACTER = 'investor';

module.exports = { CHARACTERS, LORD_SIDE_CHARACTERS, POLICE_SIDE_CHARACTERS, INVESTOR_CHARACTER };
