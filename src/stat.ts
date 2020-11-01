export interface DeckStat {
	readonly periodStart: string;
	readonly decklist: string;
	readonly finalDecklist: string;
	readonly playerClass: string;
	readonly heroCardId: string;
	readonly heroPowerCardId: string;
	readonly signatureTreasureCardId: string;
	readonly treasuresCardIds: readonly string[];
	readonly runId: string;
	readonly wins: number;
	readonly losses: number;
	readonly rating: number;
	readonly runStartDate: string;
}
