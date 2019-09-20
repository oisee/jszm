"use strict";

const G=require("genasync"); // A package I wrote
const JSZM=require("./jszm.js"); // version 2
const readline=require("readline");
const fs=require("fs");
const SortedMap=require('sorted-map');

const In=readline.createInterface({input: process.stdin});
const Out=process.stdout;

G.defineER(fs,"readFile","readFileG",2);
G.defineER(fs,"writeFile","writeFileG",3);
G.defineR(In,"question","questionG",1);

class DeadError extends Error { }
class NoMoreTurns extends Error { }

class Playthrough {
  constructor() {
    this.turns = [];
  }
  addturn(cmd, toks) {
    this.turns.push({cmd:cmd, toks:toks});
  }
}

G.run((function*() {
  var story=yield fs.readFileG(process.argv[2],{});
  var game=new JSZM(story);
  var vocab;		// vocabulary for game
  var vocabdict = {};	// .. in dictionary form

  var numplays = 0;	// # of plays in all games
  var allcmdstats = {};	// command -> record
  var ignorecmds = {}; // no longer used JSON.parse(fs.readFileSync('ignorecmds.json'));
  var rankedcmds;
  var playthru;		// current game Playthrough
  var alltokstats = {}; // token -> record
  var tokfreq = new SortedMap();	// tokens sorted by score

  var playtoks;		// tokens for current game
  var playvocab;	// vocabulary for current game (intersects game vocab)
  var numturns;		// # of turns in current game
  var maxturns = 20;	// max turns in current game
  var goaltok;		// current goal token
  var goalrec;		// current token record from 'alltokstats'
  
  var turncmd;		// last game command
  var turnscore;	// current turn score
  var turnmods;		// # of VM modifications for current turn
  var turntoks;		// tokens for current turn
  function logtoken(token) {
    turntoks[token] = 1;
  }
  game.log = (a,b,c) => {
    turnmods += 1;
    if (a == 'pf') return; // use as evidence of activity, but don't record
    logtoken(a+"_"+b+"_"+c);
  }
  function newgame() {
    // sort commands by rank (best first)
    if ((numplays++ & 15) == 0) {
      rankedcmds = []
      for (var cmd in allcmdstats) {
        var cmdstats = allcmdstats[cmd];
        if (cmdstats.score > 0 && !ignorecmds[cmd])
          rankedcmds.push(cmdstats);
      }
      rankedcmds.sort((a,b) => { return b.score - a.score });
    }
    // reset other stuff
    playtoks = new Set();
    playvocab = new Set();
    turntoks = {};
    turnmods = 0;
    turnscore = 0;
    numturns = -1;
    turncmd = null;
    playthru = new Playthrough();
    // choose a goal token, update statistics
    var goal = tokfreq.slice(0,10);
    goaltok = goal && goal.length && rndchoice(goal).key;
    goalrec = alltokstats[goaltok];
    if (goalrec) {
      goalrec.goalruns += 1;
      updatetokfreq(goaltok, goalrec);
      console.log("GOAL:",goal,goalrec.count,goalrec.first,goaltok);
    }
  }
  function metgoal() {
    if (goalrec) {
      goalrec.goalsucc += 1;
      console.log("Goal met:",goaltok,goalrec.goalsucc,'/',goalrec.goalruns);
      goalrec = null;
    }
  }
  function endgame() {
    // did we not meet goal?
    if (goaltok && !goalrec) {
      console.log("Goal not met:", goaltok);
    }
  }
  function updatetokfreq(token, stat) {
    if (!stat) stat = alltokstats[token];
    // revisit tokens except those generated by 1st turn
    if (stat.first > 0)
      tokfreq.set(token, stat.count + stat.goalruns + stat.goalsucc + stat.first);
    else
      tokfreq.del(token);
  }
  function committurn(rew) {
    // ignore first turn
    if (numturns < 0)
      turnmods = 0;
    else
      playthru.addturn(turncmd, turntoks);
    // did we hit our goal?
    if (goaltok && turntoks[goaltok]) {
      metgoal();
    }
    // ignore command if it did nothing
    if (/*turnmods == 0 || */!turncmd) {
      if (turncmd) {
        //ignorecmds[turncmd] = 1;
        console.log("IGNORING", turncmd);
      }
    } else {
      // create command stats
      var verb = turncmd; //.split(' ')[0];
      let thiscmdstats = allcmdstats[verb];
      if (!thiscmdstats)
        thiscmdstats = allcmdstats[verb] = {
          cmd:verb,
          toks:{},
          score:0
        };
      // look at all tokens for this turn
      for (let token in turntoks) {
        // new token?
        let stat = alltokstats[token];
        if (!stat) {
          stat = alltokstats[token] = {
            count: 0,
            goalruns: 0,
            goalsucc: 0,
            first: 99999,
            cmd: turncmd
          };
          turnscore += 1;
        }
        stat.count += 1;
        // update token in sorted list
        // tokens have priority if they are uncommon and haven't had many goal attempts or successes
        updatetokfreq(token, stat);
        // record best walkthrough
        if (numturns < stat.first) {
          console.log(token, numturns, '<', stat.first, '(', stat.count, ')');
          stat.first = numturns;
          stat.cmd = turncmd;
          stat.best = playthru;
          if (numturns == 0) console.log("SOLVED", token);
        }
        // new token for this cmd?
        if (!thiscmdstats.toks[token]) {
          thiscmdstats.toks[token] = 1;
          turnscore += 1;
        }
      }
      thiscmdstats.score += turnscore;
      console.log(turncmd,'+',turnscore,'=',thiscmdstats.score);
      // add to playtoks
      for (let token in turntoks) {
        playtoks.add(token);
      }
    }
    // reset for next turn
    turntoks = {};
    turnscore = 0;
    turnmods = 0;
    numturns++;
    if (numturns >= maxturns) throw new NoMoreTurns();
  }
  game.print=function*(x) {
    // did we die? abort play
    if (/RESTART, RESTORE, or QUIT/.exec(x)) {
      committurn(-1);
      throw new DeadError();
    }
    // convert to token
    if (x.length >= 3 && !vocabdict[x] && !parseInt(x)) {
      let tok = x.substr(0, 32).trim();
      logtoken(tok);
    }
    // split tokens, see if this is a vocab word
    for (var w of x.split(/[^a-z]/i)) {
      if (w && (w=w.toLowerCase()) && vocabdict[w]) playvocab.add(w);
    }
    // print to console
    Out.write(x,"ascii");
  };
  function makevocab() {
    // create word list if not present
    if (!vocab) {
      var keys = game.vocabulary.keys();
      vocab=Array.from(keys).filter((s) => { return /^\w/.exec(s) });
      vocab=vocab.filter((s) => { return !/^(restor|restar|save|q|quit)$/.exec(s) });
      vocab.forEach((w) => { vocabdict[w]=1; });
    }
  }
  function rndchoice(list, len) {
    if (!len) len = list.length;
    var i = Math.floor(Math.random() * len);
    return list[i];
  }
  function getrandomcmd() {
    // use recently seen words more often
    var words1 = playvocab.size>10 && Array.from(playvocab);
    var words2 = vocab;
    do {
      var s = "";
      for (let i=0; i<2; i++) {
        if (i>0) s += " ";
        if (words1 && Math.random() < 0.8)
          s += rndchoice(words1);
        else
          s += rndchoice(words2);
        if (Math.random() < 0.5)
          break;
      }
    } while (ignorecmds[s]);
    return s;
  }
  game.read=function*() {
    committurn(1);
    makevocab();
    // if we have a goal, get next command from playthrough
    if (goalrec && goalrec.best && numturns <= goalrec.first) {
      turncmd = rndchoice(goalrec.best.turns, goalrec.first+1).cmd;
      console.log(turncmd);
      return turncmd;
    }
    // get command ranked by "goodness"
    /*
    if (rankedcmds.length && Math.random() < 0.5) {
      var i = Math.floor(Math.pow(Math.random(), 3) * rankedcmds.length);
      turncmd = rankedcmds[i].cmd;
      //if (playvocab.size > 10 && Math.random() < 0.5)
        //turncmd += ' ' + rndchoice(Array.from(playvocab));
      console.log(turncmd, '=', rankedcmds[i].score, '#', i);
      return turncmd;
    }
    */
    // get totally random command
    turncmd = getrandomcmd();
    console.log(turncmd);
    return turncmd;
    //return yield In.questionG("");
  };
  game.save=function*(x) {
    var n,e;
    Out.write("Save? ","ascii");
    n=yield In.questionG("");
    if(!n) return false;
    try {
      yield fs.writeFileG(n,new Buffer(x.buffer),{});
      return true;
    } catch(e) {
      return false;
    }
  };
  game.restore=function*() {
    var n,e;
    Out.write("Restore? ","ascii");
    n=yield In.questionG("");
    if(!n) return null;
    try {
      return new Uint8Array(yield fs.readFileG(n,{}));
    } catch(e) {
      return null;
    }
  };
  while (1) {
    try {
      newgame();
      yield*game.run();
    } catch(e) {
      if (e instanceof DeadError) {
        console.log(turncmd,'killed you');
        delete allcmdstats[turncmd]; // TODO?
        if (0) {
          fs.writeFileSync('ignorecmds.json.tmp',JSON.stringify(ignorecmds));
          fs.renameSync('ignorecmds.json.tmp', 'ignorecmds.json');
        }
      } else if (e instanceof NoMoreTurns) {
        //
      } else
        throw e;
    }
    endgame();
  }
  process.exit(0);
})());
