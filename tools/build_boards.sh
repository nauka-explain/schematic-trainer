#!/bin/bash
# Пересборка всех плат. Пути к исходникам правятся здесь.
set -e; cd "$(dirname "$0")"; OUT=../boards; LIB3D=${LIB3D:-/home/claude/lib3d}
build(){ id=$1; sch=$2; pcb=$3; title=$4; sub=$5; lvl=$6
  mkdir -p $OUT/$id
  python3 kicad_sch_to_web.py "$sch" $OUT/$id/data.js $id "$title" "$sub" $lvl > /tmp/build_$id.log
  python3 check_sch_vs_pcb.py $OUT/$id/data.js "$pcb" | head -3
  [ -n "$pcb" ] && python3 kicad_pcb_to_model.py "$pcb" $LIB3D $OUT/$id/model.js $id | tail -1
}
build lm317 "/home/claude/cand/ik/LM317-Adjustable-PowerSupply-HEAD/pcb/ADJUSTABLE_PS_LM317/ADJUSTABLE_PS_LM317.kicad_sch" "/home/claude/cand/ik/LM317-Adjustable-PowerSupply-HEAD/pcb/ADJUSTABLE_PS_LM317/ADJUSTABLE_PS_LM317.kicad_pcb" "Регулируемый блок питания LM317" "Стабилизатор напряжения" 2
build psu5v "/home/claude/cand/nia/Basic-PCB-Projects-HEAD/project 1/5V regulated power supply shematic.kicad_sch" "/home/claude/cand/nia/Basic-PCB-Projects-HEAD/project 1/5V regulated power supply pcbdesign.kicad_pcb" "Блок питания 5 В" "Трансформатор, выпрямитель, стабилизатор" 2
build astable "/home/claude/cand/nia/Basic-PCB-Projects-HEAD/project 3/astable vibrator(B).kicad_sch" "/home/claude/cand/nia/Basic-PCB-Projects-HEAD/project 3/astable vibrator(B).kicad_pcb" "Мультивибратор" "Два транзистора и мигающие светодиоды" 1
