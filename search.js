"use strict";

const G=require("genasync"); // A package I wrote
const JSZM=require("./jszm.js"); // version 2
const readline=require("readline");
const fs=require("fs");
const SortedMap=require('sorted-map');
const {parse, stringify} = require('flatted/cjs');

const In=readline.createInterface({input: process.stdin});
const Out=process.stdout;

const DEBUG=false;

G.defineER(fs,"readFile","readFileG",2);
G.defineER(fs,"writeFile","writeFileG",3);
G.defineR(In,"question","questionG",1);

class DeadError extends Error { }
class NoMoreTurns extends Error { }

// TODO: loadstate doesn't restore classes
class Playthrough {
  constructor() {
    this.turns = [];
  }
  addturn(cmd, toks, replay) {
    this.turns.push({cmd:cmd, toks:Array.from(toks), replay:replay});
  }
}

var story_filename=process.argv[2];
var checkp_filename=process.argv[3];
var story=fs.readFileSync(story_filename);
var game=new JSZM(story);

function GameRunner() {

  var vocab;		// vocabulary for game
  var vocabdict = new Set();	// .. in dictionary form
  var maxturns = 50;	// max turns in current game
  var usewords = true;	// use word output as tokens?
  var wordtoklen = 20;  // truncate phrases to this length
  var usetech = true;	// use vm tech output?
  var usecondtok = !true; // use conditional (__) tokens?
  var usevmhack = true;	// fuzz the VM too?
  var prob_vocab = 0.5; // probability of a recent vocab word
  var prob_end = 0.5;   // probability of ending the command
  var stablethresh = 5; // token considered stable after this many successes (per turn)
  var prescoretok = "Your score is"; // true if we use SCORE command
  var scoremult = 100;	// multiplier for goal priority

  var ignorecmds = {}; // no longer used JSON.parse(fs.readFileSync('ignorecmds.json'));
  var alltokstats = {}; // token -> record
  var stabletoks = new Set();
  var vmtoks = [];
  var tokfreq = new SortedMap();	// tokens sorted by score
  var numplays = 0;

  var playthru;		// current game Playthrough
  var playtoks;		// tokens for current game
  var playvocab;	// vocabulary for current game (intersects game vocab)
  var playstate;	// current state tokens of game
  var numturns;		// # of turns in current game
  var goaltok;		// current goal token
  var goalrec;		// current token record from 'alltokstats'
  var goalmet;		// 1 = goal met
  var curscore;		// current score
  var hacks;		// list of hacks in current game
  
  var turncmd = null;	// last game command
  var turnmods;		// # of VM modifications for current turn
  var turntoks;		// tokens for current turn
  var turnisreplay;	// true if current turn is a replay
  var nexttokisscore;	// true if next token is the score
  
  
  function debug(...args) {
    if (DEBUG) console.log.apply(console, args);
  }
  function info(...args) {
    console.log.apply(console, args);
  }
  this.savestate = function() {
    return stringify({ numplays:numplays, alltokstats:alltokstats, stabletoks:Array.from(stabletoks.keys()) });
  }
  this.loadstate = function(s) {
    numplays = s.numplays;
    alltokstats = s.alltokstats;
    for (var tok of s.stabletoks) { makestable(tok); }
    for (var tok in s.alltokstats) { updatetokfreq(tok); }
  }
  // load checkpoint?
  if (checkp_filename) {
    console.log("LOADING", checkp_filename);
    this.loadstate(parse(fs.readFileSync(checkp_filename)));
  }
  this.checkpoint = function() {
    info("CHECKPOINT", numplays);
    fs.writeFileSync(story_filename+".save.tmp", this.savestate());
    fs.renameSync(story_filename+".save.tmp", story_filename+".save");
  }
  function addtoken(token) {
    if (turncmd === null) return; // don't record tokens before 1st turn
    let stat = alltokstats[token];
    // new token? create record
    if (!stat) {
      stat = alltokstats[token] = {
        token: token,
        count: 0,
        goalruns: 0,
        goalsucc: 0,
        first: 99999,
        cmd: turncmd,
        stablecount: 0,
        maxscore: 0,
      };
      info("NEWTOKEN",token,turncmd);
      showcommands();
    }
    turntoks.add(stat.token); // string interning
  }
  function logtoken(token) {
    addtoken(token);
    // log all prior tokens, combined
    if (usecondtok && stabletoks.has(token) /*&& token.startsWith('@')*/) {
      for (var priortok of playtoks) {
        if (stabletoks.has(priortok) && priortok.indexOf(token) < 0 && priortok.startsWith('@')) {
          var key = priortok + "__" + token;
          if (!turntoks.has(key)) { addtoken(key); } 
        }
      }
    }
  }
  game.log = (a,b,c) => {
    turnmods += 1;
    if (usetech) {
      if (a == 'pf' || a == 'rand') return; // use as evidence of activity, but don't record
      var key = a+"_"+b+"_"+c;
      turntoks.delete("@"+a+"_"+b+"_"+playstate[b]);
      playstate[b] = c;
      logtoken("@"+key);
    }
  }
  
  game.logbranch = (op,taken) => {
    //game.log('br',op,taken?1:0);
    return 0;
    //return Math.random() < 0.001 ? 1 : 0;
  }
  this.newgame = function() {
    // reset other stuff
    playtoks = new Set();
    playvocab = new Set();
    playstate = new Map();
    turntoks = new Set();
    turnmods = 0;
    numturns = -1;
    turncmd = null;
    hacks = [];
    playthru = new Playthrough();
    // choose a goal token, update statistics
    var goal = tokfreq.slice(0,10);
    goaltok = goal && goal.length && rndchoice(goal).key;
    goalrec = alltokstats[goaltok];
    goalmet = 0;
    if (goalrec) {
      goalrec.goalruns += 1;
      updatetokfreq(goaltok, goalrec);
      debug("GOAL:",goalrec.cmd,goal,goalrec.count,goalrec.first,goaltok);
    }
  }
  function showcommands() {
    if (hacks.length) info("HACKS",hacks.join(' '));
    info('COMMANDS', playthru.turns.slice(0,playthru.turns.length).map((t) => { return t.cmd }).join(', '));
  }
  function makestable(tok) {
    if (!stabletoks.has(tok)) {
      stabletoks.add(tok);
      vmtoks = Array.from(stabletoks).filter((tok) => tok.startsWith("@mv_")); // TODO
      if (playthru) {
        info("STABLE", goaltok);
        showcommands();
      }
    }
  }
  function makeunstable(tok) {
    if (stabletoks.has(tok)) {
      stabletoks.delete(goaltok);
      info("UNSTABLE", goaltok);
      showcommands();
    }
  }
  function metgoal() {
    if (!goalmet) {
      goalrec.goalsucc += 1;
      debug("Goal success:",goaltok,goalrec.goalsucc,'/',goalrec.goalruns,'turn #',numturns);
      // is this token stable yet?
      var thresh = stablethresh * (goalrec.first+1);
      goalrec.stablecount += 1;
      if (goalrec.stablecount >= thresh) {
        makestable(goaltok);
      } else if (goalrec.stablecount < thresh/2) {
        makeunstable(goaltok);
      }
      goalmet = 1;
    }
  }
  this.endgame = function() {
    // did we not meet goal?
    if (goaltok && !goalmet) {
      debug("Goal failure:",goaltok,goalrec.goalsucc,'/',goalrec.goalruns);
      goalrec.stablecount = Math.max(goalrec.stablecount-2, 0);
    }
    if ((++numplays % 10000) == 0) this.checkpoint();
  }
  function updatetokfreq(token, stat) {
    if (!stat) stat = alltokstats[token];
    // revisit tokens except those generated by 1st turn
    if (stat.first > 0) {
      var priority = stat.goalruns + stat.goalsucc + stat.stablecount + stat.first - stat.maxscore*scoremult;
      tokfreq.set(token, priority);
    } else {
      tokfreq.del(token);
    }
  }
  function committurn(rew) {
    // ignore first turn
    if (numturns < 0)
      turnmods = 0;
    else
      playthru.addturn(turncmd, turntoks, turnisreplay);
    // did we hit our goal?
    if (goaltok && turntoks.has(goaltok)) {
      metgoal();
    }
    // ignore command if it did nothing
    if (/*turnmods == 0 || */!turncmd) {
      if (turncmd) {
        //ignorecmds[turncmd] = 1;
        debug("IGNORING", turncmd);
      }
    } else {
      // look at all tokens for this turn
      for (let token of turntoks) {
        let stat = alltokstats[token];
        stat.count += 1;
        // update token in sorted list
        // tokens have priority if they are uncommon and haven't had many goal attempts or successes
        updatetokfreq(token, stat);
        // record best walkthrough
        if (playthru.turns.length-1 < stat.first) {
          info('REDUCE', token, playthru.turns.length-1, '<', stat.first, '(', stat.goalsucc, '/', stat.goalruns, '/', stat.count, ')');
          showcommands();
          // if this is 1st turn, don't bother replaying
          if (numturns == 0) {
            stat.best = null;
          } else {
            stat.best = playthru;
          }
          stat.first = playthru.turns.length-1;
          stat.cmd = turncmd;
        }
      }
      // add to playtoks
      for (let token of turntoks) {
        playtoks.add(token);
      }
    }
    // reset for next turn
    turntoks = new Set();
    turnmods = 0;
    numturns++;
  }
  game.print=function*(x) {
    // did we die? abort play
    if (/RESTART, RESTORE, or QUIT/.exec(x)) { // TODO
      committurn(-1);
      throw new DeadError();
    }
    // convert to token
    if (usewords) {
      if (x.length >= 3 && !vocabdict.has(x) && isNaN(parseInt(x))) {
        let tok = x.substr(0, wordtoklen).trim();
        logtoken(tok);
        if (prescoretok && tok == prescoretok) { nexttokisscore = true; }
      } else if (nexttokisscore) {
        nexttokisscore = false;
        curscore = parseInt(x);
        if (goalrec && curscore > goalrec.maxscore) {
          goalrec.maxscore = curscore;
          console.log("SCORE", goaltok, curscore);
          updatetokfreq(goaltok, goalrec);
        }
      }
    }
    // split tokens, see if this is a vocab word
    for (var w of x.split(/[^a-z]/i)) {
      if (w && w.length >= 3 && (w=w.toLowerCase()) && vocabdict.has(w)) playvocab.add(w);
    }
    //console.log("VOCAB",Array.from(playvocab).join(' '));
    // print to console
    if (DEBUG) Out.write(x,"ascii");
  };
  function makevocab() {
    // create word list if not present
    if (!vocab) {
      var keys = game.vocabulary.keys();
      vocab=Array.from(keys).filter((s) => { return /^\w/.exec(s) });
      vocab=vocab.filter((s) => { return !/^(restor|restar|save|q|quit)$/.exec(s) });
      vocab.forEach((w) => { vocabdict.add(w); });
    }
  }
  function rndchoice(list, first, len) {
    if (!first) first = 0;
    if (!len) len = list.length - first;
    var i = Math.floor(first + Math.random() * len);
    return list[i];
  }
  function getrandomcmd() {
    // use recently seen words more often
    var words1 = Array.from(playvocab);
    var words2 = vocab;
    do {
      var s = "";
      for (let i=0; i<2; i++) {
        if (i>0) s += " ";
        // use vocab? recent words first
        if (words1.length && Math.random() < prob_vocab)
          s += rndchoice(words1, Math.random()*words1.length);
        else
          s += rndchoice(words2);
        if (Math.random() < prob_end)
          break;
      }
    } while (ignorecmds[s]);
    return s;
  }
  function hackvm() {
    if (!goalrec) return;
    // hack probability increases as token gets more stable
    var prob = goalrec.stablecount * 0.1;
    if (numturns == 0 && Math.random() < prob && stabletoks.has(goaltok)) {
      // choose a stable token to hack with
      var tok = rndchoice(vmtoks);
      // move object x to parent y
      if (tok && tok.startsWith("@mv_")) {
        var toks = tok.split("_");
        var x = parseInt(toks[1])
        var y = parseInt(toks[2])
        game.mv(x,y);
        hacks.push(tok);
        // add probable hacked commands to beginning of playthrough
        var bestrec = alltokstats[tok];
        if (bestrec && bestrec.best) {
          for (var i=0; i<=bestrec.first; i++) {
            var turn = bestrec.best.turns[i];
            playthru.addturn(turn.cmd, turn.toks, true);
          }
        }
      }
    }
  }
  game.read=function*() {
    committurn(1);
    if (numturns == maxturns && prescoretok) { turncmd=null; numturns++; return "SCORE"; }
    if (numturns > maxturns) throw new NoMoreTurns();
    makevocab();
    if (usevmhack) hackvm();
    // if we have a goal, get next command from playthrough
    let op;
    turnisreplay = false;
    if (goalrec && goalrec.best) {
      let best = goalrec.best;
      let turn = goalrec.best.turns[numturns];
      // on first attempts, just stick the last command(s) at the end
      if (goalrec.goalruns <= 2 && turn) {
        if (turn.replay) {
          turncmd = turn.cmd;
          op = "(Replay)";
          turnisreplay = true;
        } else {
          if (goalrec.goalruns < 2 || goalrec.first == 0)
            turncmd = best.turns[goalrec.first].cmd; // last command
          else
            turncmd = best.turns[goalrec.first - (numturns&1)].cmd; // alternate last two commands
          op = "(Last)";
        }
      } else if (numturns <= goalrec.first) {
        // get random/shuffled command?
        let rnd = Math.random() < (2 + goalrec.first*goalrec.first) / (1 + goalrec.goalsucc + goalrec.goalruns*turn.replay);
        if (rnd) {
          if (Math.random() < 0.75) { // shuffle = pick from best playthru at random
            turncmd = rndchoice(best.turns, 0, goalrec.first+1).cmd;
            op = "(shuffle)";
          }
        } else { // replay = pick from playthru in order
          turncmd = turn.cmd;
          op = "(replay)";
          turnisreplay = true;
        }
      }
    }
    // get totally random command
    if (!op) {
      turncmd = getrandomcmd();
      op = "(random)";
    }
    debug('CMD', numturns, turncmd, op, goaltok);
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
  game.restarted = function*() {
    runner.newgame();
  }
}

var runner = new GameRunner();

function*GrunOne() {
  {
    try {
      yield*game.run();
    } catch(e) {
      if (e instanceof DeadError) {
        //console.log(turncmd,'killed you');
      } else if (e instanceof NoMoreTurns) {
        //console.log("END");
      } else if (e.message != null && e.message.startsWith("JSZM:")) {
        console.log("ERROR", e.message);
      } else {
        throw e;
      }
    }
    runner.endgame();
  }
  process.nextTick(runOne);
}

function runOne() {
  G.run(GrunOne);
}
process.nextTick(runOne);

