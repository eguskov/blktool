{
  function notNull(arr) { return arr.filter(function(v) { return v !== null; }); }
  function filterByType(arr, type) { return arr ? arr.filter ? arr.filter(function(v) { return v['_type'] === type; }).map(function(v) { return v.value; }) : arr : []; }
  function blockContent(name, location, src) {
    return {
      name: name,
      location: location,
      params: filterByType(src, 'param'),
      blocks: filterByType(src, 'block'),
      includes: filterByType(src, 'include'),
      comments: filterByType(src, 'comment'),
      emptylines: filterByType(src, 'empty line'),
    }
  }
}

DataBlock = blk:DataBlockElements { return blockContent('', location(), blk); }

DataBlockElements = head:DataBlockElement tail:(DataBlockElement)* { return notNull([head].concat(tail)); }
DataBlockElement = Block / Param / Include / Comment / EmptyLine / Spaces
Block "Block" = name:Name _ "{" inner: DataBlockElements* "}"
{
  var content = notNull(inner)[0];
  return {
    '_type': 'block',
    value: blockContent(name, location(), content)
  };
}

Include "Include" = "include" _ value:Strings ((Spaces* &"}") / EOL / EOF) { return {
    '_type': 'include',
    value: {
      location: location(),
      value: value
    }
  };
}

// Use EOP to enforce ; at the end of param value
Param "Param" = indent:Indent name:Name value:TypeWithValue EOPR { return {
    '_type': 'param',
    value: {
      location: location(),
      indent: indent,
      value: [name].concat(value)
    }
  };
}

Indent = [ \t]* { return location(); }

Value "Value of Param" = Strings
Name "Name of Param or Block" = NameString / '"' n:String '"' { return '"'+n+'"'; }
NameString = [a-zA-Z0-9_\.]+ { return text(); }

TypeWithValue = ":" value:(
  /*
  StringValue /
  RealValue /
  IntValue /
  Int64Value /
  BoolValue /
  Point2Value /
  Point3Value /
  Point4Value /
  IPoint2Value /
  IPoint3Value /
  IPoint4Value /
  ColorValue /
  TMatrixValue /
  */
  ParamValue
)
{ return value; }

ParamValue "ParamValue" = t:ParamType _ "=" _ v:(s:QuotedString { return '"'+s+'"'; } / ParamAnyValue) { return [t, v]; }
ParamType "ParamType" = [a-zA-Z0-9]+ { return text(); }
ParamAnyValue "ParamAnyValue" = (!EOP Char)* { return text(); }

StringValue = "t" _ "=" _ v:Strings { return ["t", v]; }
RealValue   = "r" _ "=" _ v:Number { return ["r", v]; }
IntValue    = "i" _ "=" _ v:IntNumber { return ["i", v]; }
Int64Value  = "i64" _ "=" _ v:IntNumber { return ["i64", v]; }
BoolValue   = "b" _ "=" _ v:("yes" / "no" / "on" / "off" / "true" / "false" / "1" / "0" ) { return ["b", v]; }

Point2Value = "p2" _ "=" _ n0:Number _ "," _ n1:Number  { return ["p2", [n0, n1]]; }
Point3Value = "p3" _ "=" _ n0:Number _ "," _ n1:Number _ "," _ n2:Number  { return ["p3", [n0, n1, n2]]; }
Point4Value = "p4" _ "=" _ n0:Number _ "," _ n1:Number _ "," _ n2:Number _ "," _ n3:Number  { return ["p4", [n0, n1, n2, n3]]; }

IPoint2Value = "ip2" _ "=" _ n0:IntNumber _ "," _ n1:IntNumber { return ["ip2", [n0, n1]]; }
IPoint3Value = "ip3" _ "=" _ n0:IntNumber _ "," _ n1:IntNumber _ "," _ n2:IntNumber { return ["ip3", [n0, n1, n2]]; }
IPoint4Value = "ip4" _ "=" _ n0:IntNumber _ "," _ n1:IntNumber _ "," _ n2:IntNumber _ "," _ n3:IntNumber  { return ["ip4", [n0, n1, n2, n3]]; }

ColorValue = "c" _ "=" _ n0:IntNumber _ "," _ n1:IntNumber _ "," _ n2:IntNumber _ "," _ n3:IntNumber  { return ["c", [n0, n1, n2, n3]]; }

TMatrixValue = "m" _ "=" _
"[" _
  "[" _ row0:Point3 _ "]" _
  "[" _ row1:Point3 _ "]" _
  "[" _ row2:Point3 _ "]" _
  "[" _ row3:Point3 _ "]" _
"]"
{ return ["m", [row0, row1, row2, row3]]; }

Point3 = n0:Number _ "," _ n1:Number _ "," _ n2:Number { return [n0, n1, n2]; }

Comment "Comment" = indent:Indent c:(CommentLine / CommentBlock) { return {
    '_type': 'comment',
    value: {
      location: location(),
      indent: indent,
      value: c
    }
  };
}
CommentLine "CommentLine" = "//" (!EOL Char)* { return text(); }
CommentBlock "CommentBlock" = "/*" (!"*/" Char)* "*/" { return text(); }
EmptyLine "Empty line" = [ \t]* EOL { return { '_type': 'empty line', value: { location: location() } }; }

Strings "Strings" = QuotedString / UnquotedString / EmptyString
QuotedString "QuotedString" = DoubleQuotedString / SingleQuotedString
String "String" = (!EOL [^"])+ { return text(); }
SString "SString" = [^']+ { return text(); }
EmptyString "Empty String" = ('"' '"' / "'" "'") { return ''; }
UnquotedString "String" = (![\r\n} ] [^"])+ { return text(); }
DoubleQuotedString "String" = '"' s:String '"' { return s; }
SingleQuotedString "String" = "'" s:SString "'" { return s; }
Number "RealNumber" = RealNumber / IntNumber
RealNumber "RealNumber" = [0-9\.\-]+ { return text(); }
IntNumber "IntNumber" = [0-9\-]+ { return text(); }
Char = .
_ "Whitespace" = [ \r\n\t]* { return null; }
Spaces "Spaces" = [ ]+ { return null; }

EOL "EndOfLine" = [\r\n] { return "EOL"; }
EOP "EndOfParam" = (Spaces* (";" / &"//" / &"/*" / &"}" / EOL)) / EOF
EOPR "EndOfParamRelaxed" = &"//" / &"/*" / &"}" / (Spaces* ";") / "" / EOL / EOF
EOF "EndOfFile" = !. { return "EOF"; }