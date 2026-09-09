export class TennisMatch {
  constructor(){this.reset();}
  reset(){this.points=[0,0];this.games=[0,0];this.server=0;this.gameNumber=1;}
  pointLabel(){
    if(this.points[0]>=3&&this.points[1]>=3){
      if(this.points[0]===this.points[1])return 'DEUCE';
      return this.points[0]>this.points[1]?'ADVANTAGE P1':'ADVANTAGE P2';
    }
    const l=['LOVE','15','30','40'];
    return `${l[this.points[0]]||'40'} - ${l[this.points[1]]||'40'}`;
  }
  point(winner){
    if(winner!==0&&winner!==1)throw new Error('Invalid winner');
    const loser=winner^1;
    if(this.points[0]>=3&&this.points[1]>=3){
      if(this.points[0]===this.points[1])this.points[winner]=4;
      else if(this.points[winner]===4){
        this.games[winner]++;
        this.points=[0,0];
        this.server^=1;
        this.gameNumber++;
        return {gameWon:true,matchWon:this.games[winner]>=6};
      }else{this.points=[3,3];}
    }else{
      this.points[winner]++;
      if(this.points[winner]>=4&&this.points[loser]<=2){
        this.games[winner]++;
        this.points=[0,0];
        this.server^=1;
        this.gameNumber++;
        return {gameWon:true,matchWon:this.games[winner]>=6};
      }
    }
    return {gameWon:false,matchWon:false};
  }
}
